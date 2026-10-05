"""Network-free checks for pagination, failure evidence, and completeness claims."""
import importlib.util
import json
import tempfile
import unittest
import urllib.error
import sys
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "skills/yantu-scout/scripts/clinicaltrials.py"
sys.path.insert(0, str(SOURCE.parent))
import clinicaltrials as direct



def study(number):
    return {"protocolSection": {"identificationModule": {
        "nctId": f"NCT{number:08d}", "briefTitle": "Synthetic test record"}}}


class FakeClient:
    def __init__(self, out, responses):
        self.out, self.responses, self.calls = Path(out), iter(responses), []
        self.events = []

    def get(self, path, params, label):
        self.calls.append((path, dict(params), label))
        return next(self.responses)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def collect(self, responses, max_pages=10, token=None):
        client = FakeClient(self.temp.name, responses)
        summary, studies = direct.collect(client, {"query.intr": "test", "pageSize": 2,
                                                  "countTotal": "true"}, max_pages, token)
        return summary, studies, client

    def test_real_response_token_forwarded_and_query_unchanged(self):
        summary, studies, client = self.collect([
            {"studies": [study(1), study(2)], "totalCount": 3, "nextPageToken": "opaque+/="},
            {"studies": [study(3)], "totalCount": 3}])
        first, second = client.calls[0][1], client.calls[1][1]
        self.assertEqual(second.pop("pageToken"), "opaque+/=")
        self.assertEqual(first, second)
        self.assertTrue(summary["query_retrieval_verified"])
        self.assertEqual(len(studies), 3)

    def test_page_limit_keeps_unconsumed_token_and_incomplete_status(self):
        summary, _, _ = self.collect([
            {"studies": [study(1)], "totalCount": 2, "nextPageToken": "next"}], max_pages=1)
        self.assertFalse(summary["query_retrieval_verified"])
        self.assertEqual(summary["stop_reason"], "page_limit")
        self.assertEqual(summary["next_page_token"], "next")

    def test_second_page_failure_preserves_first_page(self):
        summary, studies, _ = self.collect([
            {"studies": [study(1)], "totalCount": 2, "nextPageToken": "next"}, None])
        self.assertEqual(len(studies), 1)
        self.assertEqual(summary["next_page_token"], "next")
        self.assertEqual(summary["stop_reason"], "request_failed")
        self.assertFalse(summary["query_retrieval_verified"])

    def test_duplicates_never_count_as_complete(self):
        summary, studies, _ = self.collect([
            {"studies": [study(1)], "totalCount": 1, "nextPageToken": "next"},
            {"studies": [study(1)], "totalCount": 1}])
        self.assertEqual(len(studies), 1)
        self.assertEqual(summary["duplicate_count"], 1)
        self.assertFalse(summary["query_retrieval_verified"])

    def test_repeated_token_stops(self):
        summary, _, client = self.collect([
            {"studies": [study(1)], "nextPageToken": "next"},
            {"studies": [study(2)], "nextPageToken": "next"}])
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(summary["stop_reason"], "repeated_token")

    def test_resume_segment_never_claims_full_query(self):
        summary, _, _ = self.collect([{"studies": [study(2)], "totalCount": 1}], token="resume")
        self.assertTrue(summary["reached_end"])
        self.assertFalse(summary["started_from_first_page"])
        self.assertFalse(summary["query_retrieval_verified"])

    def test_missing_total_not_inferred_as_zero(self):
        summary, _, _ = self.collect([{"studies": []}])
        self.assertEqual(summary["reported_total_counts"], [])
        self.assertFalse(summary["query_retrieval_verified"])

    def test_missing_nct_and_changed_total_flagged(self):
        summary, _, _ = self.collect([
            {"studies": [study(1), {}], "totalCount": 2, "nextPageToken": "next"},
            {"studies": [study(2)], "totalCount": 3}])
        self.assertEqual(summary["invalid_nct_count"], 1)
        self.assertFalse(summary["total_count_consistent"])
        self.assertFalse(summary["query_retrieval_verified"])

    def test_invalid_detail_not_passed(self):
        self.assertEqual(direct.detail_summary({}, "NCT00000001")["status"], "field_validation_failed")

    def test_network_denial_has_no_http_status_or_fabricated_body(self):
        class Denied:
            def open(self, *args, **kwargs):
                raise urllib.error.URLError(PermissionError("Synthetic permission denial"))
        client = direct.Client(self.temp.name)
        client.opener = Denied()
        self.assertIsNone(client.get("/studies", {}, "denied"))
        event = client.events[0]
        self.assertIsNone(event["http_status"])
        self.assertEqual(event["error_type"], "PERMISSION_ERROR")
        self.assertNotIn("raw_file", event)
        self.assertEqual(len(client.events), 1)

    def test_official_body_bytes_saved_unchanged(self):
        body = b'{ "studies" : [], "totalCount": 0 }\n'
        class Response:
            status = 200
            headers = {"Content-Type": "application/json"}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return body
        class Opener:
            def open(self, *args, **kwargs): return Response()
        client = direct.Client(self.temp.name)
        client.opener = Opener()
        self.assertEqual(client.get("/studies", {}, "body")["totalCount"], 0)
        event = client.events[0]
        self.assertEqual((Path(self.temp.name) / event["raw_file"]).read_bytes(), body)

    def test_cross_origin_redirect_rejected(self):
        with self.assertRaises(urllib.error.URLError):
            direct.OfficialRedirect().redirect_request(None, None, 302, "", {}, "https://example.com/")


if __name__ == "__main__":
    unittest.main(verbosity=2)
