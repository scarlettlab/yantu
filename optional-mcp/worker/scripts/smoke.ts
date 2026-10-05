import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { TOOL_RESULT_LIMIT, bytes, obj, type Obj } from "../src/core";
import { sectionNames } from "../src/schemas";

const endpoint = process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp";
const client = new Client({ name: "yantu-scout-smoke", version: "0.2.1" });
const report: Record<string, unknown> = { testedAt: new Date().toISOString(), endpoint, calls: [] };
const calls = report.calls as Record<string, unknown>[];

async function call(name: string, args: Record<string, unknown>): Promise<Obj> {
  const result = await client.callTool({ name, arguments: args });
  const payload = result.structuredContent as Obj;
  assert.ok(bytes(result) <= TOOL_RESULT_LIMIT, `Response too large: ${name}`);
  assert.ok(payload, "No structuredContent");
  calls.push({ name, section: args.section, responseBytes: bytes(result), ok: payload.ok, sectionComplete: payload.sectionComplete, startEntry: payload.startEntry, endEntryExclusive: payload.endEntryExclusive });
  assert.equal(result.isError, false, JSON.stringify(payload));
  return payload;
}

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ["getStudyByNCT", "searchStudies"]);
  for (const tool of tools.tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.openWorldHint, true);
  }
  report.tools = tools.tools.map(t => t.name);
  const searchTool = tools.tools.find(t => t.name === "searchStudies")!;
  assert.equal((searchTool.inputSchema.properties?.pageSize as { default?: number }).default, 20);
  assert.match(searchTool.description ?? "", /取回候选不等于已逐条初筛/);
  const searchArgs = { queryIntr: "semaglutide" };
  const first = await call("searchStudies", searchArgs);
  assert.equal(first.returnedCount, 20); assert.equal(first.hasMore, true);
  assert.equal(obj(first.screening).screenedCount, null);
  assert.equal(obj(first.screening).screeningStatus, "not_verified_by_mcp");
  const second = await call("searchStudies", { ...searchArgs, pageToken: first.nextPageToken });
  assert.notDeepEqual(first.studies, second.studies);
  assert.equal(second.totalCount, first.totalCount);
  if (process.argv.includes("--screening-checkpoint")) {
    let page = second;
    let count = Number(first.returnedCount) + Number(second.returnedCount);
    const seen = new Set((first.studies as Obj[]).concat(second.studies as Obj[]).map(s => String(s.nctId)));
    while (count < 200 && page.nextPageToken) {
      page = await call("searchStudies", { ...searchArgs, pageToken: page.nextPageToken, remainingBeforePause: 200 - count });
      count += Number(page.returnedCount);
      for (const s of page.studies as Obj[]) seen.add(String(s.nctId));
      assert.equal(page.totalCount, first.totalCount);
    }
    assert.equal(count, 200);
    assert.equal(obj(page.screening).requiresUserDecision, true);
    const blocked = await client.callTool({ name: "searchStudies", arguments: { ...searchArgs, pageToken: page.nextPageToken } });
    assert.equal(blocked.isError, true);
    assert.equal(obj((blocked.structuredContent as Obj).error).code, "SCREENING_CHECKPOINT");
    report.screening = { totalCount: first.totalCount, returnedRecords: count, uniqueNctCount: seen.size, checkpointBlocked: true, remainingInQuery: Number(first.totalCount) - seen.size, continuedBeyond200: false };
    console.log(`Screening checkpoint: ${count} records, blocked before fetching more.`);
  }
  await call("searchStudies", { queryIntr: "semaglutide", phases: ["PHASE1", "PHASE2"], pageSize: 1 });
  const nctId = "NCT03548935";
  const overview = await call("getStudyByNCT", { nctId });
  assert.equal(overview.nctId, nctId);
  const expectedLastUpdate = obj(overview.source).lastUpdate;
  const checkedSections = process.argv.includes("--all-sections") ? sectionNames.filter(s => s !== "overview") : ["arms", "primary_outcomes", "participant_flow", "results_index", "outcome_result", "serious_events", "other_events"];
  let largest = 0;
  for (const section of checkedSections) {
    const args: Record<string, unknown> = { nctId, section, expectedLastUpdate, ...(section === "outcome_result" ? { outcomeIndex: 0 } : {}) };
    let result: Obj;
    let pageCount = 0;
    do {
      result = await call("getStudyByNCT", args);
      if (result.nextCursor) args.cursor = result.nextCursor;
      pageCount++;
      assert.ok(pageCount < 100, "Unbounded pagination");
    } while (result.nextCursor);
    assert.equal(result.sectionComplete, true);
    largest = Math.max(largest, pageCount);
    console.log(`${section}: ${pageCount} page(s), complete`);
  }
  assert.ok(largest > 1, "Large fixture did not exercise pagination");
  // Legacy protocol must remain discoverable for existing ChatGPT MCP clients.
  const initResponse = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "legacy-smoke", version: "1" } } }) });
  const initBody = await initResponse.text();
  assert.equal(initResponse.status, 200, initBody);
  assert.match(initBody, /protocolVersion/);
  report.legacyInitialization = true;
  report.passed = true;
  report.maxToolResultBytes = Math.max(...calls.map(c => Number(c.responseBytes)));
  console.log(`Passed: ${calls.length} calls; largest tool response ${report.maxToolResultBytes} bytes.`);
} catch (error) {
  report.passed = false; report.error = String(error); process.exitCode = 1; console.error(error);
} finally {
  await writeFile(process.env.MCP_REPORT_PATH ?? "test-results.local.json", JSON.stringify(report, null, 2) + "\n");
  await client.close();
}
