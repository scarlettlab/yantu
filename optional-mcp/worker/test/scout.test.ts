import test from "node:test";
import assert from "node:assert/strict";
import { ClinicalTrialsClient } from "../src/api";
import { ScoutService } from "../src/clinical";
import { TOOL_RESULT_LIMIT, ScoutError, bytes, obj, runTool, tokenEncode, toolResult, type Json, type Obj } from "../src/core";
import { entries, pageData } from "../src/paging";
import { searchSchema, studySchema } from "../src/schemas";

const identity = { identificationModule: { nctId: "NCT03548935", briefTitle: "Example" }, statusModule: { lastUpdatePostDateStruct: { date: "2026-09-01", type: "ACTUAL" } } };
const study = (extra: Obj = {}): Obj => ({ protocolSection: identity, hasResults: true, ...extra });
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json", ...init?.headers } });
const service = (record: Obj) => new ScoutService(new ClinicalTrialsClient(async () => json(record)));
const errorCode = (code: string) => (e: unknown) => e instanceof ScoutError && e.code === code;

test("Search sends fields, structured dimensions and supported phase syntax; pages retain candidates", async () => {
  const urls: URL[] = [];
  const client = new ClinicalTrialsClient(async url => {
    const u = new URL(url); urls.push(u);
    return json({ studies: [study({ protocolSection: { ...identity, identificationModule: { nctId: u.searchParams.has("pageToken") ? "NCT03548936" : "NCT03548935" } } })], ...(u.searchParams.has("pageToken") ? {} : { nextPageToken: "opaque+token/=" }), totalCount: 2 });
  });
  const app = new ScoutService(client);
  const input = searchSchema.parse({ queryIntr: "semaglutide", queryCond: "obesity", phases: ["PHASE1", "PHASE2"], pageSize: 1 });
  const first = await app.search(input);
  const second = await app.search({ ...input, pageToken: first.nextPageToken as string });
  assert.equal(urls[0].searchParams.get("query.intr"), "semaglutide");
  assert.equal(urls[0].searchParams.get("query.cond"), "obesity");
  assert.equal(urls[0].searchParams.get("filter.advanced"), "AREA[Phase](PHASE1 OR PHASE2)");
  assert.equal(urls[0].searchParams.has("filter.phase"), false);
  assert.ok(urls[0].searchParams.get("fields")?.includes("NCTId"));
  assert.equal(urls[1].searchParams.get("pageToken"), "opaque+token/=");
  assert.equal(first.hasMore, true); assert.equal(second.hasMore, false);
  assert.notDeepEqual(first.studies, second.studies);
  await assert.rejects(app.search({ ...input, queryIntr: "different", pageToken: first.nextPageToken as string }), errorCode("CURSOR_SCOPE_MISMATCH"));
});

test("Empty search pages with a next token remain continuable", async () => {
  const result = await service({ studies: [], nextPageToken: "more", totalCount: 10 }).search(searchSchema.parse({ queryTerm: "x" }));
  assert.equal(result.returnedCount, 0); assert.equal(result.hasMore, true);
});

test("Default retrieval checkpoint reads 200, separates retrieval from screening, pauses and resumes on approval", async () => {
  const requested: { start: number; size: number }[] = [];
  const app = new ScoutService(new ClinicalTrialsClient(async url => {
    const params = new URL(url).searchParams;
    const start = Number(params.get("pageToken") ?? 0);
    const size = Number(params.get("pageSize"));
    requested.push({ start, size });
    return json({ studies: Array.from({ length: size }, (_, i) => study({ protocolSection: { ...identity, identificationModule: { nctId: `NCT${String(start + i + 1).padStart(8, "0")}` } } })), nextPageToken: String(start + size), ...(start === 0 ? { totalCount: 480 } : {}) });
  }));
  const input = searchSchema.parse({ queryIntr: "example" });
  assert.equal(input.pageSize, 20);
  let token: string | undefined;
  let last: Obj = {};
  const seen = new Set<string>();
  for (let i = 0; i < 10; i++) {
    last = await app.search({ ...input, pageToken: token });
    token = last.nextPageToken as string;
    for (const s of last.studies as Obj[]) seen.add(String(s.nctId));
    assert.equal(last.totalCount, 480, "Total from first page must survive subsequent pages without totalCount");
    assert.equal(obj(last.screening).requiresUserDecision, i === 9);
  }
  assert.equal(seen.size, 200);
  assert.equal(obj(last.screening).cumulativeRetrievedCount, 200);
  assert.equal(obj(last.screening).retrievalStatus, "candidate_summaries_retrieved");
  assert.equal(obj(last.screening).screenedCount, null);
  assert.equal(obj(last.screening).screeningStatus, "not_verified_by_mcp");
  assert.match(String(obj(last.screening).countBasis), /不得直接写为实际完成初筛数/);
  await assert.rejects(app.search({ ...input, pageToken: token }), errorCode("SCREENING_CHECKPOINT"));
  assert.equal(requested.length, 10, "Checkpoint must stop before an upstream request");
  const resumed = await app.search({ ...input, pageToken: token, allowBeyond200: true });
  assert.equal(obj((resumed.studies as Obj[])[0]).nctId, "NCT00000201");
  assert.equal(obj(resumed.screening).cumulativeRetrievedCount, 220);
  assert.equal(obj(resumed.screening).requiresUserDecision, false);
});

test("Task remaining allowance prevents crossing 200 across aliases, including zero remaining", async () => {
  let requests = 0;
  const app = new ScoutService(new ClinicalTrialsClient(async url => {
    requests++;
    const size = Number(new URL(url).searchParams.get("pageSize"));
    return json({ studies: Array.from({ length: size }, (_, i) => study({ protocolSection: { ...identity, identificationModule: { nctId: `NCT${String(i + 1).padStart(8, "0")}` } } })), nextPageToken: "more", totalCount: 500 });
  }));
  const partial = await app.search(searchSchema.parse({ queryTerm: "alias", remainingBeforePause: 7 }));
  assert.equal(partial.returnedCount, 7);
  assert.equal(partial.effectivePageSize, 7);
  assert.equal(obj(partial.screening).requiresUserDecision, true);
  await assert.rejects(app.search(searchSchema.parse({ queryTerm: "other alias", remainingBeforePause: 0 })), errorCode("SCREENING_CHECKPOINT"));
  assert.equal(requests, 1);
});

test("Large search pages shrink upstream pageSize without discarding candidates", async () => {
  const sizes: number[] = [];
  const app = new ScoutService(new ClinicalTrialsClient(async url => {
    const count = Number(new URL(url).searchParams.get("pageSize")); sizes.push(count);
    return json({ studies: Array.from({ length: count }, (_, i) => study({ protocolSection: { ...identity, identificationModule: { nctId: `NCT${String(i + 1).padStart(8, "0")}`, briefTitle: "a".repeat(1600) } } })), nextPageToken: `after-${count}` });
  }));
  const result = await app.search(searchSchema.parse({ queryTerm: "x", pageSize: 50 }));
  assert.ok(sizes.length > 1); assert.equal(result.returnedCount, result.effectivePageSize);
  assert.equal(result.hasMore, true); assert.ok(bytes(toolResult(result)) <= TOOL_RESULT_LIMIT);
});

test("Missing studies, invalid NCT and unbounded search are explicit errors", async () => {
  await assert.rejects(service({}).search(searchSchema.parse({ queryTerm: "x" })), errorCode("UPSTREAM_SCHEMA_ERROR"));
  await assert.rejects(service({}).search(searchSchema.parse({})), errorCode("QUERY_REQUIRED"));
  assert.throws(() => studySchema.parse({ nctId: "../../secret" }));
  assert.throws(() => searchSchema.parse({ queryTerm: "x", pageSize: 1000 }));
});

test("Overview requests projected fields; source identity and date attributes are retained", async () => {
  let url = "";
  const record = study({ protocolSection: { ...identity, designModule: { enrollmentInfo: { count: 200, type: "ESTIMATED" } }, statusModule: { ...identity.statusModule, startDateStruct: { date: "2026-03", type: "ESTIMATED" } } } });
  const app = new ScoutService(new ClinicalTrialsClient(async u => { url = u; return json(record); }));
  const result = await app.getStudy(studySchema.parse({ nctId: "NCT03548935" }));
  assert.ok(new URL(url).searchParams.has("fields"));
  assert.ok(!new URL(url).searchParams.get("fields")?.includes("ResultsSection"));
  assert.equal(result.section, "overview");
  assert.equal(obj(result.source).lastUpdate, "2026-09-01");
  assert.deepEqual(obj(obj(obj(result.data).protocolSection).designModule).enrollmentInfo, { count: 200, type: "ESTIMATED" });
  await assert.rejects(app.getStudy(studySchema.parse({ nctId: "NCT03548935", expectedLastUpdate: "2026-08-01" })), errorCode("SOURCE_CHANGED"));
});

test("Protocol endpoints and measured outcome results remain distinct; one result keeps group denominators", async () => {
  const outcome = { type: "PRIMARY", title: "Weight", timeFrame: "Week 68", groups: [{ id: "G1", title: "Drug" }], denoms: [{ units: "Participants", counts: [{ groupId: "G1", value: "101" }] }], classes: [{ categories: [{ measurements: [{ groupId: "G1", value: "-12.3" }] }] }] };
  const app = service(study({ protocolSection: { ...identity, outcomesModule: { primaryOutcomes: [{ measure: "Weight", timeFrame: "Week 68" }] } }, resultsSection: { outcomeMeasuresModule: { outcomeMeasures: [outcome, { type: "SECONDARY", title: "Waist" }] } } }));
  const base = { nctId: "NCT03548935" };
  const planned = await app.getStudy(studySchema.parse({ ...base, section: "primary_outcomes" }));
  const measured = await app.getStudy(studySchema.parse({ ...base, section: "outcome_result", outcomeIndex: 0 }));
  assert.notDeepEqual(planned.data, measured.data); assert.deepEqual(measured.data, outcome);
  await assert.rejects(app.getStudy(studySchema.parse({ ...base, section: "outcome_result" })), errorCode("MISSING_OUTCOME_INDEX"));
  await assert.rejects(app.getStudy(studySchema.parse({ ...base, section: "outcome_result", outcomeIndex: 2 })), errorCode("OUTCOME_INDEX_OUT_OF_RANGE"));
  await assert.rejects(app.getStudy(studySchema.parse({ ...base, section: "design", outcomeIndex: 0 })), errorCode("UNEXPECTED_OUTCOME_INDEX"));
});

test("Missing sections are registry-only absence, not proof of no public evidence", async () => {
  const result = await service(study({ hasResults: false })).getStudy(studySchema.parse({ nctId: "NCT03548935", section: "participant_flow" }));
  assert.equal(result.availability, "not_in_registry_record"); assert.equal(result.data, null);
  assert.equal(result.sectionComplete, true); assert.match(String(result.evidenceBoundary), /补检/);
  await assert.rejects(service(study()).getStudy(studySchema.parse({ nctId: "NCT00000000" })), errorCode("RECORD_MISMATCH"));
});

test("Large nested results page without losing leaves, nulls, empty arrays, group IDs or Unicode", async () => {
  const data: Json = { groups: [{ id: "G2", title: "Control" }, { id: "G1", title: "Drug" }], unit: "人数", empty: [], missing: null, text: '🙂中文"\\\n'.repeat(4000), results: Array.from({ length: 300 }, (_, i) => ({ groupId: i % 2 ? "G2" : "G1", value: String(i), denom: i + 100 })) };
  let cursor: string | undefined;
  const actual: unknown[] = [];
  let pages = 0;
  do {
    const page = await pageData(data, "NCT:outcome:0", "2026-09-01", cursor);
    assert.equal(page.format, "json_pointer_entries");
    assert.equal(page.startEntry, actual.length);
    actual.push(...page.data as Json[]);
    assert.ok(bytes(toolResult({ ok: true, ...page })) <= TOOL_RESULT_LIMIT);
    cursor = page.nextCursor as string | undefined;
    assert.equal(page.sectionComplete, !cursor);
    pages++;
  } while (cursor);
  assert.ok(pages > 2); assert.deepEqual(actual, entries(data));
  const textParts = (actual as { path: string; value: string }[]).filter(x => x.path === "/text");
  assert.equal(textParts.map(x => x.value).join(""), data.text);
});

test("Page cursors reject wrong section, altered source, forged offsets and malformed encoding", async () => {
  const data: Json = { text: "x".repeat(40000) };
  const first = await pageData(data, "scope", "v1"); const cursor = first.nextCursor as string;
  await assert.rejects(pageData(data, "other", "v1", cursor), errorCode("CURSOR_SCOPE_MISMATCH"));
  await assert.rejects(pageData({ text: "y".repeat(40000) }, "scope", "v1", cursor), errorCode("SOURCE_CHANGED"));
  await assert.rejects(pageData(data, "scope", "v2", cursor), errorCode("SOURCE_CHANGED"));
  await assert.rejects(pageData(data, "scope", "v1", "!invalid"), errorCode("INVALID_CURSOR"));
  await assert.rejects(pageData(data, "scope", "v1", tokenEncode({ v: 1, scope: "scope", digest: first.digest, offset: 999999 })), errorCode("INVALID_CURSOR"));
});

test("Long Retry-After returns promptly and 429 remains an error", async () => {
  let slept = false;
  const client = new ClinicalTrialsClient(async () => new Response("", { status: 429, headers: { "retry-after": "60" } }), async () => { slept = true; });
  await assert.rejects(client.get("/studies", new URLSearchParams()), errorCode("RATE_LIMITED"));
  assert.equal(slept, false);
});

test("Transient 503 has one bounded retry; 404 is not interpreted as withdrawn", async () => {
  let requests = 0;
  const client = new ClinicalTrialsClient(async () => ++requests === 1 ? new Response("", { status: 503 }) : json({ studies: [] }), async () => {});
  assert.deepEqual((await client.get("/studies", new URLSearchParams())).data, { studies: [] }); assert.equal(requests, 2);
  const result = await runTool(() => new ClinicalTrialsClient(async () => new Response("", { status: 404 })).get("/studies/NCT00000000", new URLSearchParams()).then(x => x.data));
  assert.equal(result.isError, true); assert.equal(obj(result.structuredContent.error).code, "STUDY_NOT_FOUND");
});

test("Timeout, invalid JSON, large upstream body and invalid host path are controlled", async () => {
  const timeout = new ClinicalTrialsClient(async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); }), async () => {}, 5);
  await assert.rejects(timeout.get("/studies", new URLSearchParams()), errorCode("UPSTREAM_TIMEOUT"));
  await assert.rejects(new ClinicalTrialsClient(async () => new Response("html")).get("/studies", new URLSearchParams()), errorCode("UPSTREAM_INVALID_JSON"));
  await assert.rejects(new ClinicalTrialsClient(async () => new Response("x".repeat(8 * 1024 * 1024 + 1))).get("/studies", new URLSearchParams()), errorCode("UPSTREAM_TOO_LARGE"));
  await assert.rejects(timeout.get("https://other.example/", new URLSearchParams()), errorCode("INVALID_PATH"));
});

test("Final envelope stays bounded and does not silently return partial success", () => {
  const result = toolResult({ ok: true, text: "x".repeat(60000) });
  assert.equal(result.isError, true); assert.ok(bytes(result) <= TOOL_RESULT_LIMIT);
  assert.equal(obj(result.structuredContent.error).code, "OUTPUT_BUDGET_EXCEEDED");
});
