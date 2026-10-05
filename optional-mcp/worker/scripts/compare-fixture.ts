import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { entries, type Entry } from "../src/paging";
import { obj, type Json, type Obj } from "../src/core";

// Compare selected live modules to a full public API snapshot; no LLM interpretation.
const fixturePath = process.argv[2];
if (!fixturePath) throw new Error("Usage: node --import tsx scripts/compare-fixture.ts /path/to/public-study.json");
const snapshot = JSON.parse(await readFile(fixturePath, "utf8")) as Obj;
const nctId = obj(obj(snapshot.protocolSection).identificationModule).nctId;
const lastUpdate = obj(obj(obj(snapshot.protocolSection).statusModule).lastUpdatePostDateStruct).date;
const results = obj(snapshot.resultsSection);
const ae = obj(results.adverseEventsModule);
const expected: Record<string, Json> = {
  participant_flow: results.participantFlowModule,
  outcome_result: (obj(results.outcomeMeasuresModule).outcomeMeasures as Json[])[0],
  serious_events: Object.fromEntries(["frequencyThreshold", "timeFrame", "description", "eventGroups", "seriousEvents"].filter(k => ae[k] !== undefined).map(k => [k, ae[k]])),
};
const client = new Client({ name: "scout-integrity-check", version: "0.1.0" });
const report: unknown[] = [];
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp")));
  for (const [section, full] of Object.entries(expected)) {
    let cursor: Json = null;
    let pages = 0;
    const combined: Entry[] = [];
    do {
      const args = { nctId, section, expectedLastUpdate: lastUpdate, ...(section === "outcome_result" ? { outcomeIndex: 0 } : {}), ...(cursor ? { cursor } : {}) };
      const r = await client.callTool({ name: "getStudyByNCT", arguments: args });
      assert.equal(r.isError, false, JSON.stringify(r));
      const p = r.structuredContent as Obj;
      combined.push(...(p.format === "json" ? entries(p.data) : p.data as unknown as Entry[]));
      cursor = p.nextCursor;
      pages++;
      assert.ok(pages <= 100);
    } while (cursor);
    assert.deepEqual(combined, entries(full), `${section}: missing or altered values`);
    report.push({ section, pages, entries: combined.length, exactMatch: true });
  }
  console.log(JSON.stringify(report, null, 2));
  await writeFile("integrity-results.local.json", JSON.stringify({ testedAt: new Date().toISOString(), nctId, lastUpdate, checks: report }, null, 2) + "\n");
} finally { await client.close(); }
