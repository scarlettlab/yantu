import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'skills/yantu-scout/scripts'))
import clinicaltrials as direct
from clinicaltrials_fields import select_section


def study(number):
    return {'protocolSection': {'identificationModule': {'nctId': f'NCT{number:08d}', 'briefTitle': 'Synthetic record'}}}


class PublicReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name)

    def run_search(self, responses, *extra):
        calls = []
        class Client:
            def __init__(self, out): self.out, self.events = out, []
            def get(self, path, params, label):
                calls.append(dict(params))
                return responses.pop(0)
        with patch.object(direct, 'Client', Client), contextlib.redirect_stdout(io.StringIO()):
            exit_code = direct.main(['--mode', 'search', '--out', str(self.out), *extra])
        report_file = max(self.out.glob('*/report.json'), key=lambda p: p.stat().st_mtime_ns)
        return exit_code, json.loads(report_file.read_text()), calls, report_file

    def test_checkpoint_across_queries_and_full_authorization(self):
        rows = [study(i) for i in range(1, 101)]
        self.run_search([{'studies': rows, 'totalCount': 300, 'nextPageToken': 'one'}],
                        '--intervention', 'synthetic-a', '--max-pages', '1')
        _, second, _, _ = self.run_search([{'studies': rows, 'totalCount': 300, 'nextPageToken': 'two'}],
                                           '--sponsor', 'Synthetic Sponsor', '--max-pages', '1')
        self.assertEqual(second['search']['stop_reason'], 'candidate_checkpoint')
        code, third, calls, _ = self.run_search([], '--term', 'synthetic-c')
        self.assertEqual(code, 2)
        self.assertEqual(calls, [])
        self.assertEqual(third['search']['stop_reason'], 'candidate_checkpoint')
        code, full, _, _ = self.run_search([{'studies': [study(201)], 'totalCount': 1}],
                                            '--term', 'synthetic-d', '--allow-beyond-200')
        self.assertEqual(code, 0)
        self.assertTrue(full['search']['query_retrieval_verified'])
        self.assertIsNone(full['search']['screened_count'])

    def test_partial_batch_uses_remaining_allowance(self):
        (self.out / 'retrieval-session.json').write_text(json.dumps({'candidate_records_retrieved': 199}))
        code, report, calls, _ = self.run_search([{'studies': [study(1)], 'nextPageToken': 'more', 'totalCount': 2}],
                                                 '--intervention', 'synthetic')
        self.assertEqual(calls[0]['pageSize'], 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(report['search']['stop_reason'], 'candidate_checkpoint')
        self.assertEqual(code, 2)

    def test_smaller_explicit_allowance_even_when_all_authorized(self):
        _, report, calls, _ = self.run_search([{'studies': [study(1), study(2)], 'nextPageToken': 'more', 'totalCount': 9}],
                                              '--intervention', 'synthetic', '--allow-beyond-200', '--remaining-before-pause', '2')
        self.assertEqual(calls[0]['pageSize'], 2)
        self.assertEqual(report['search']['unique_count'], 2)
        self.assertFalse(report['search']['query_retrieval_verified'])

    def test_resume_preserves_query_and_does_not_claim_full_segment(self):
        _, first, _, file = self.run_search([{'studies': [study(1)], 'nextPageToken': 'opaque', 'totalCount': 2}],
                                             '--sponsor', 'Synthetic Sponsor', '--max-pages', '1')
        _, resumed, calls, _ = self.run_search([{'studies': [study(2)]}], '--resume-report', str(file))
        self.assertEqual(calls[0]['query.spons'], 'Synthetic Sponsor')
        self.assertEqual(calls[0]['pageToken'], 'opaque')
        self.assertFalse(resumed['search']['query_retrieval_verified'])
        self.assertTrue(resumed['search']['reached_end'])

    def test_concurrent_ledger_is_not_deleted_or_bypassed(self):
        lock = self.out / '.retrieval-session.lock'
        lock.write_text('synthetic active job')
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.run_search([], '--intervention', 'synthetic')
        self.assertEqual(lock.read_text(), 'synthetic active job')


class ModuleTests(unittest.TestCase):
    def setUp(self):
        self.record = study(1)
        self.record['protocolSection'].update({
            'statusModule': {'lastUpdatePostDateStruct': {'date': '2026-01-02'}},
            'designModule': {'enrollmentInfo': {'count': 100, 'type': 'ESTIMATED'}},
            'outcomesModule': {'primaryOutcomes': [{'measure': 'Planned definition', 'timeFrame': '24 weeks'}]}})
        self.record['resultsSection'] = {
            'participantFlowModule': {'groups': [{'id': 'FG1', 'title': 'Group A'}],
                                      'periods': [{'milestones': [{'type': 'STARTED', 'achievements': [{'groupId': 'FG1', 'numSubjects': '43'}]}]}]},
            'outcomeMeasuresModule': {'outcomeMeasures': [{'type': 'PRIMARY', 'title': 'Observed endpoint',
                'groups': [{'id': 'OG2', 'title': 'Group A'}], 'units': 'mg/dL', 'timeFrame': 'Week 24',
                'denoms': [{'units': 'Participants', 'counts': [{'groupId': 'OG2', 'value': '39'}]}],
                'analyses': [{'groupIds': ['OG2'], 'paramValue': '-12.5', 'ciLowerLimit': '-15', 'ciUpperLimit': '-10'}]}]},
            'adverseEventsModule': {'eventGroups': [{'id': 'AG9', 'atRisk': '41'}], 'timeFrame': '26 weeks',
                                    'seriousEvents': [{'term': 'Synthetic event', 'stats': [{'groupId': 'AG9', 'numAffected': '2', 'numEvents': '3'}]}]}}

    def test_results_keep_denominators_groups_units_and_statistics(self):
        result = select_section(self.record, 'NCT00000001', 'outcome_result', 0)
        self.assertEqual(result['data'], self.record['resultsSection']['outcomeMeasuresModule']['outcomeMeasures'][0])
        self.assertNotEqual(result['data']['groups'][0]['id'], 'FG1')

    def test_flow_not_enrollment(self):
        result = select_section(self.record, 'NCT00000001', 'participant_flow')
        self.assertEqual(result['data'], self.record['resultsSection']['participantFlowModule'])
        design = select_section(self.record, 'NCT00000001', 'design')
        self.assertEqual(design['data']['enrollmentInfo']['type'], 'ESTIMATED')

    def test_primary_definition_not_result(self):
        result = select_section(self.record, 'NCT00000001', 'primary_outcomes')
        self.assertEqual(result['data'][0]['measure'], 'Planned definition')

    def test_safety_preserves_context_people_and_events(self):
        result = select_section(self.record, 'NCT00000001', 'serious_events')
        self.assertEqual(result['data'], self.record['resultsSection']['adverseEventsModule'])

    def test_source_changed_and_mismatched_record_rejected(self):
        with self.assertRaisesRegex(ValueError, 'SOURCE_CHANGED'):
            select_section(self.record, 'NCT00000001', 'overview', expected_last_update='2025-01-01')
        with self.assertRaisesRegex(ValueError, 'RECORD_MISMATCH'):
            select_section(self.record, 'NCT00000002', 'overview')

    def test_missing_module_distinct_from_failed_request(self):
        result = select_section(self.record, 'NCT00000001', 'baseline')
        self.assertEqual(result['availability'], 'not_in_registry_record')
        self.assertIsNone(result['data'])
        self.assertTrue(result['section_complete'])


if __name__ == '__main__':
    unittest.main()
