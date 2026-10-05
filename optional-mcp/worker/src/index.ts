import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { ScoutService } from "./clinical";
import { runTool } from "./core";
import { searchSchema, studySchema } from "./schemas";

export function createServer(service = new ScoutService()) {
  const server = new McpServer({ name: "yantu-scout-clinicaltrials", version: "0.2.1" }, {
    instructions: "ClinicalTrials.gov公开数据只读工具。保持用户主题的广泛检索范围，不自行缩窄时间、分期或状态。默认每页20项，先取回最多200条候选摘要；达到200条后先不读取剩余候选，报告接口总命中、候选摘要取回数、去重后唯一NCT数、实际筛选数、深度分析数和待读数。MCP只能证明候选摘要已取回，不能证明模型已逐条应用纳排标准；只有逐条使用明确标准并记录纳入/排除/待定判定后，才可报告实际筛选数，否则必须写未核实，不能把取回200条写成完成初筛200项。调用方跨别名查询累计额度并传remainingBeforePause，不因新查询重置200项。仅用户已明确要求全量或同意继续时allowBeyond200=true；续查恢复额度。保留查询条件、NCT去重结果、首查totalCount和nextPageToken。多查询总数未经去重不能相加；前200项按更新时间排序不是代表性样本；阶段结果须标注检索未完成。未达暂停点时沿nextPageToken读取，即使本页为空；查询末页不代表别名和其他来源已查全。getStudyByNCT默认overview；按section取数，nextCursor存在就继续直到sectionComplete=true。先results_index再outcome_result。总样本量与各组实际人数不同，后者取participant_flow；主要终点定义与实测结果不同。保留groupId、分母、单位、时间点及实际/预计属性。跨模块传expectedLastUpdate；来源变化时重新读取。注册库缺失不代表其他来源未公开，失败不能写未公开。只解释实际读取的模块和页。",
  });
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true };
  const outputSchema = z.object({ ok: z.boolean() }).passthrough();
  server.registerTool("searchStudies", {
    title: "分页检索试验候选", description: "按药物/疾病/申办方/关键词检索ClinicalTrials.gov。默认每页20项、单页最多50项；先取回最多200条候选摘要，超过后暂停并说明总命中与剩余。跨别名查询也跟踪remainingBeforePause。仅用户已要求全量或同意继续时allowBeyond200=true，再用nextPageToken续查。取回候选不等于已逐条初筛；没有明确纳排标准和逐条判定记录时，实际筛选数必须写未核实。前200项不是代表性样本。",
    inputSchema: searchSchema, outputSchema, annotations,
  }, input => runTool(() => service.search(searchSchema.parse(input))));
  server.registerTool("getStudyByNCT", {
    title: "按模块读取单项试验", description: "按NCT号读取一个模块，默认overview。design为总人数/设计；arms为治疗组/剂量；participant_flow为各组实际人数；primary_outcomes为终点定义；results_index列结果索引，outcome_result按索引取实测结果；安全数据分摘要、严重和其他事件。大型模块逐页读取，禁止跳过nextCursor。",
    inputSchema: studySchema, outputSchema, annotations,
  }, input => runTool(() => service.getStudy(studySchema.parse(input))));
  return server;
}

const handler = createMcpHandler(() => createServer(), { route: "/mcp", responseMode: "json" });
export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return Response.json({ status: "ok", service: "yantu-scout-mcp", version: "0.2.1" });
    if (path !== "/mcp") return new Response("Use an MCP client at /mcp; health check: /health", { status: 404 });
    return handler(request, env, ctx);
  },
};
