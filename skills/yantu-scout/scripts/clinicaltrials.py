#!/usr/bin/env python3
"""Yantu public ClinicalTrials reader. Standard library; official HTTPS only."""
import argparse
import csv
import hashlib
import json
import os
import http.client
import platform
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from clinicaltrials_fields import SECTIONS, select_section

VERSION = "0.1.0-rc.1"
BASE = "https://clinicaltrials.gov/api/v2"


def utc():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        dest = urllib.parse.urlsplit(newurl)
        if dest.scheme != "https" or dest.netloc != "clinicaltrials.gov":
            raise urllib.error.URLError("Redirect outside official HTTPS origin refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Client:
    def __init__(self, out, timeout=15):
        self.out = Path(out)
        self.timeout = timeout
        self.events = []
        self.opener = urllib.request.build_opener(OfficialRedirect())

    def get(self, path, params, label):
        url = BASE + path + (("?" + urllib.parse.urlencode(params)) if params else "")
        for attempt in (1, 2):
            event = {"label": label, "attempt": attempt, "started_at": utc(),
                     "url": url, "http_status": None, "ok": False}
            body = None
            retry = False
            wait = 1
            data = None
            try:
                req = urllib.request.Request(url, headers={
                    "Accept": "application/json", "User-Agent": "YantuClinicalTrialsReader/" + VERSION})
                with self.opener.open(req, timeout=self.timeout) as response:
                    event["http_status"] = response.status
                    event["content_type"] = response.headers.get("Content-Type")
                    body = response.read()
                data = json.loads(body)
                if not isinstance(data, dict):
                    raise ValueError("Expected a JSON object")
                event["ok"] = True
            except urllib.error.HTTPError as exc:
                event["http_status"] = exc.code
                event["error_type"] = "HTTP_ERROR"
                event["error"] = str(exc)
                try:
                    body = exc.read()
                except OSError:
                    pass
                retry = exc.code == 429 or 500 <= exc.code <= 599
                retry_after = exc.headers.get("Retry-After", "") if exc.headers else ""
                # Do not retry earlier than a long server-requested wait.
                if retry_after:
                    if retry_after.isdigit() and int(retry_after) <= 10:
                        wait = max(1, int(retry_after))
                    else:
                        retry = False
            except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as exc:
                reason = getattr(exc, "reason", exc)
                if isinstance(reason, socket.gaierror):
                    category = "DNS_ERROR"
                elif isinstance(reason, (TimeoutError, socket.timeout)):
                    category = "TIMEOUT"
                elif isinstance(reason, PermissionError):
                    category = "PERMISSION_ERROR"
                elif isinstance(reason, ssl.SSLError):
                    category = "TLS_ERROR"
                elif isinstance(exc, ValueError):
                    category = "INVALID_JSON"
                else:
                    category = "NETWORK_ERROR"
                event.update(error_type=category, error=str(exc))
            if body is not None:
                suffix = ".json" if event["ok"] else ".body"
                filename = f"{label}.attempt-{attempt}{suffix}"
                (self.out / filename).write_bytes(body)
                event.update(raw_file=filename, bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
            event["finished_at"] = utc()
            self.events.append(event)
            # Persist evidence after every attempt, even if the host interrupts later.
            write_json(self.out / "requests.json", self.events)
            print(json.dumps({"step": label, "attempt": attempt,
                              "http_status": event["http_status"], "ok": event["ok"],
                              "error_type": event.get("error_type")}), flush=True)
            if event["ok"]:
                return data
            if not retry or attempt == 2:
                return None
            time.sleep(wait)
        return None


def identity(study):
    return study.get("protocolSection", {}).get("identificationModule", {})


def collect(client, params, max_pages, start_token=None, candidate_limit=None, on_page=None):
    token = start_token
    consumed_tokens = set()
    unique = {}
    pages = []
    total_counts = []
    raw_count = 0
    invalid_count = 0
    stop = "page_limit"
    reached_end = False
    for page in range(1, max_pages + 1):
        if candidate_limit is not None and raw_count >= candidate_limit:
            stop = "candidate_checkpoint"
            break
        query = dict(params)
        if candidate_limit is not None:
            query['pageSize'] = min(params['pageSize'], candidate_limit - raw_count)
        if token:
            if token in consumed_tokens:
                stop = "repeated_token"
                break
            consumed_tokens.add(token)
            query["pageToken"] = token
        data = client.get("/studies", query, f"page-{page:03d}")
        if data is None:
            stop = "request_failed"
            break
        studies = data.get("studies")
        if not isinstance(studies, list):
            stop = "invalid_studies_schema"
            break
        if len(studies) > query['pageSize']:
            stop = "upstream_exceeded_requested_page_size"
            break
        next_token = data.get("nextPageToken")
        if next_token is not None and not isinstance(next_token, str):
            stop = "invalid_token_schema"
            break
        total = data.get("totalCount")
        if isinstance(total, int) and not isinstance(total, bool):
            total_counts.append(total)
        page_ids = []
        for study in studies:
            raw_count += 1
            try:
                nct = identity(study).get("nctId")
            except (AttributeError, TypeError):
                nct = None
            if not isinstance(nct, str) or not re.fullmatch(r"NCT\d{8}", nct):
                invalid_count += 1
                continue
            unique[nct] = study
            page_ids.append(nct)
        pages.append({"page": page, "count": len(studies), "nct_ids": page_ids,
                      "request_page_token": token, "response_next_page_token": next_token,
                      "total_count": total})
        if on_page is not None:
            on_page(raw_count)
        token = next_token or None
        write_json(client.out / "checkpoint.json", {
            "query_params": params, "started_from_first_page": not bool(start_token),
            "pages": pages, "next_page_token": token, "unique_count_so_far": len(unique)})
        if not token:
            reached_end = True
            stop = "end_of_results"
            break
        if token in consumed_tokens:
            stop = "repeated_token"
            break
    if token and candidate_limit is not None and raw_count >= candidate_limit and stop == 'page_limit':
        stop = 'candidate_checkpoint'
    duplicate_count = raw_count - invalid_count - len(unique)
    totals_consistent = bool(total_counts) and len(set(total_counts)) == 1
    total_matches = totals_consistent and total_counts[0] == len(unique)
    verification = bool(not start_token and reached_end and total_matches
                        and invalid_count == 0 and duplicate_count == 0)
    summary = {"query_params": params, "started_from_first_page": not bool(start_token),
               "pages": pages, "pages_received": len(pages), "raw_count": raw_count,
               "unique_count": len(unique), "duplicate_count": duplicate_count,
               "invalid_nct_count": invalid_count, "reported_total_counts": total_counts,
               "total_count_consistent": totals_consistent,
               "unique_count_matches_total": bool(total_matches), "stop_reason": stop,
               "reached_end": reached_end, "next_page_token": token,
               "query_retrieval_verified": verification,
               "systematic_review_completed": False}
    summary['screened_count'] = None
    summary['screening_status'] = 'not_verified_by_retrieval'
    summary['candidate_limit_this_run'] = candidate_limit
    return summary, list(unique.values())


def detail_summary(data, expected_nct):
    if not isinstance(data, dict):
        return {"status": "request_failed"}
    try:
        protocol = data["protocolSection"]
        info = protocol["identificationModule"]
        outcomes = protocol.get("outcomesModule", {}).get("primaryOutcomes")
        enrollment = protocol.get("designModule", {}).get("enrollmentInfo")
        updated = protocol.get("statusModule", {}).get("lastUpdatePostDateStruct")
        valid = (info.get("nctId") == expected_nct and isinstance(info.get("briefTitle"), str)
                 and isinstance(enrollment, dict) and isinstance(updated, dict)
                 and isinstance(outcomes, list))
        return {"status": "passed" if valid else "field_validation_failed",
                "nct_id": info.get("nctId"), "brief_title": info.get("briefTitle"),
                "enrollment_info": enrollment, "last_update_post_date": updated,
                "primary_outcomes_count": len(outcomes) if isinstance(outcomes, list) else None,
                "has_results_section": "resultsSection" in data}
    except (KeyError, TypeError, AttributeError):
        return {"status": "field_validation_failed"}


def csv_cell(value):
    text = str(value or "")
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@")) else text


def save_studies(out, studies):
    write_json(out / "studies.json", studies)
    with (out / "studies.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["NCTId", "BriefTitle", "OfficialURL"])
        for study in studies:
            info = identity(study)
            writer.writerow([info["nctId"], csv_cell(info.get("briefTitle", "")),
                             "https://clinicaltrials.gov/study/" + info["nctId"]])


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--version", action="version", version=f"{VERSION}; Python {platform.python_version()}")
    p.add_argument("--mode", choices=["probe", "search", "study"], default="probe")
    p.add_argument("--intervention")
    p.add_argument("--condition")
    p.add_argument("--term")
    p.add_argument("--sponsor")
    p.add_argument("--nct")
    p.add_argument("--section", choices=SECTIONS, default='overview')
    p.add_argument("--outcome-index", type=int)
    p.add_argument("--expected-last-update")
    p.add_argument("--allow-beyond-200", action='store_true', help='Only when the user has requested all results or authorized continuation')
    p.add_argument("--remaining-before-pause", type=int, help='Optional smaller batch allowance, also applies with --allow-beyond-200')
    p.add_argument("--page-size", type=int, default=100)
    p.add_argument("--max-pages", type=int, default=10)
    p.add_argument("--resume-report", type=Path, help='Resume an interrupted segment with its saved query and token; no new query flags')
    p.add_argument("--out", type=Path, default=Path("clinicaltrials-output"), help='One directory per research task; search runs share its 200-candidate ledger')
    return p


def main(argv=None):
    p = parser()
    args = p.parse_args(argv)
    if not 1 <= args.page_size <= 1000 or not 1 <= args.max_pages <= 100:
        p.error("page-size must be 1..1000; max-pages must be 1..100")
    if args.remaining_before_pause is not None and args.remaining_before_pause < 0:
        p.error('remaining-before-pause cannot be negative')
    if args.mode == "probe" and (args.intervention or args.condition or args.term or args.sponsor or args.resume_report):
        p.error("probe uses its fixed small test; use search for custom queries")
    if args.mode == 'study' and (not args.nct or not re.fullmatch(r'NCT\d{8}', args.nct)):
        p.error('study requires --nct NCT followed by eight digits')
    if args.outcome_index is not None and (args.mode != 'study' or args.section != 'outcome_result' or args.outcome_index < 0):
        p.error('outcome-index is a nonnegative index for study/outcome_result only')
    resume = None
    if args.resume_report:
        if args.mode != 'search' or any((args.intervention, args.condition, args.term, args.sponsor)):
            p.error('resume-report requires search and no new query flags')
        resume = json.loads(args.resume_report.read_text())['search']
        if not resume.get('next_page_token'):
            p.error('saved report has no unconsumed next-page token')
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    out = args.out / stamp
    out.mkdir(parents=True, exist_ok=False)
    script_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    report = {"script_version": VERSION, "script_sha256": script_hash,
              "mode": args.mode, "started_at": utc(), "python": platform.python_version(),
              "os": platform.system(), "execution_location": "must_be_reported_by_host",
              "transport": "Python urllib HTTPS to clinicaltrials.gov; host network settings unchanged",
              "status": "running", "script_executed": True}
    write_json(out / "report.json", report)
    print(json.dumps({"output_directory": str(out), "script_version": VERSION,
                      "script_sha256": script_hash}), flush=True)
    client = Client(out)
    if args.mode == 'study':
        data = client.get('/studies/' + args.nct, {}, 'detail-' + args.nct)
        report['status'] = 'request_failed'
        if data is not None:
            try:
                module = select_section(data, args.nct, args.section, args.outcome_index, args.expected_last_update)
                write_json(out / 'section.json', module)
                report.update(status='section_saved', section_file='section.json',
                              section_complete=module['section_complete'], availability=module['availability'],
                              source_last_update=module['source_last_update'])
            except (ValueError, TypeError, KeyError, AttributeError) as exc:
                report.update(status='section_validation_failed', error=str(exc))
        report.update(requests=client.events, finished_at=utc())
        write_json(out / 'report.json', report)
        print(json.dumps({'status': report['status'], 'report': str(out / 'report.json')}), flush=True)
        return 0 if report['status'] == 'section_saved' else 2
    params = {"format": "json", "countTotal": "true", "sort": "LastUpdatePostDate:desc"}
    if args.mode == "probe":
        params.update({"query.intr": "semaglutide", "pageSize": 2, "fields": "NCTId,BriefTitle"})
        max_pages = 2
    else:
        params["pageSize"] = args.page_size
        for key, value in (("query.intr", args.intervention), ("query.cond", args.condition),
                           ("query.term", args.term), ("query.spons", args.sponsor)):
            if value:
                params[key] = value
        if not any((args.intervention, args.condition, args.term, args.sponsor)) and not resume:
            p.error('search requires an explicit intervention, condition, sponsor or term')
        max_pages = args.max_pages
    if resume:
        params = resume['query_params']
        allowed = {'format', 'countTotal', 'sort', 'pageSize', 'query.intr', 'query.cond', 'query.term', 'query.spons', 'fields'}
        if not isinstance(params, dict) or set(params) - allowed or not isinstance(params.get('pageSize'), int) or not 1 <= params['pageSize'] <= 1000:
            p.error('invalid resume query parameters')
    candidate_limit = None
    ledger_file = args.out / 'retrieval-session.json'
    lock = args.out / '.retrieval-session.lock'
    acquired = False
    prior = 0
    def checkpoint(raw_count):
        pending = ledger_file.with_suffix('.tmp')
        write_json(pending, {'candidate_records_retrieved': prior + raw_count, 'updated_at': utc(),
                             'count_basis': 'retrieved records across queries, before deduplication',
                             'latest_run': out.name})
        pending.replace(ledger_file)
    try:
        if args.mode == 'search':
            try:
                descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(descriptor)
                acquired = True
            except FileExistsError:
                p.error('another search holds this task ledger; do not run concurrent searches in the same output directory')
            if ledger_file.exists():
                prior = json.loads(ledger_file.read_text())['candidate_records_retrieved']
                if isinstance(prior, bool) or not isinstance(prior, int) or prior < 0:
                    p.error('invalid task ledger; preserve it and inspect before continuing')
            candidate_limit = None if args.allow_beyond_200 else max(0, 200 - prior)
            if args.remaining_before_pause is not None:
                candidate_limit = args.remaining_before_pause if candidate_limit is None else min(candidate_limit, args.remaining_before_pause)
        summary, studies = collect(client, params, max_pages, resume['next_page_token'] if resume else None,
                                   candidate_limit, checkpoint if args.mode == 'search' else None)
    finally:
        if acquired:
            lock.unlink()
    report['task_retrieved_before_run'] = prior
    report['allow_beyond_200'] = args.allow_beyond_200
    if resume:
        report['resumed_from_report'] = str(args.resume_report)
        report['resume_boundary'] = 'Continuation segment only; combine with prior segments and deduplicate before declaring full-query coverage.'
    report["search"] = summary
    save_studies(out, studies)
    if args.mode == "probe":
        pages = summary["pages"]
        pagination_ok = bool(len(pages) == 2 and pages[0]["response_next_page_token"]
                             and pages[1]["request_page_token"] == pages[0]["response_next_page_token"]
                             and all(page["count"] == 2 for page in pages)
                             and summary["unique_count"] == 4 and summary["invalid_nct_count"] == 0
                             and summary['stop_reason'] in ('page_limit', 'end_of_results')
                             and summary["total_count_consistent"])
        report["pagination_probe_status"] = "passed" if pagination_ok else "not_passed"
        report["detail"] = detail_summary(client.get("/studies/NCT03548935", {}, "detail-NCT03548935"),
                                           "NCT03548935")
        passed = pagination_ok and report["detail"]["status"] == "passed"
        report["status"] = "probe_passed" if passed else "probe_not_passed"
    else:
        passed = summary["query_retrieval_verified"]
        report["status"] = "query_retrieval_verified" if passed else "incomplete_or_needs_review"
    report["requests"] = client.events
    report["finished_at"] = utc()
    report["boundary"] = "Retrieval evidence for this query only; not completed screening or comprehensive research."
    write_json(out / "report.json", report)
    print(json.dumps({"status": report["status"], "pages_received": summary["pages_received"],
                      "unique_count": summary["unique_count"], "reached_end": summary["reached_end"],
                      "stop_reason": summary["stop_reason"], "report": str(out / "report.json")}), flush=True)
    return 0 if passed else 2


if __name__ == "__main__":
    sys.exit(main())
