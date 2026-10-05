import { ClinicalTrialsClient } from "./api";
import { API_BASE, DATA_BUDGET, ScoutError, arr, at, bytes, digest, obj, tokenDecode, tokenEncode, type Json, type Obj } from "./core";
import { pageData } from "./paging";
import { sectionNames, type SearchInput, type StudyInput } from "./schemas";

const identityFields = ["NCTId", "BriefTitle", "LastUpdatePostDateStruct", "HasResults"];
type SectionSpec = { fields: string[]; select: (s: Obj, input: StudyInput) => Json | undefined; note: string };
const moduleSpec = (root: string, module: string, field: string, note: string): SectionSpec => ({ fields: [field], select: s => at(s, [root, module]), note });
const protocol = (module: string, field: string, note: string) => moduleSpec("protocolSection", module, field, note);
const aeBase = "resultsSection.adverseEventsModule";
const aeContext = ["frequencyThreshold", "timeFrame", "description", "eventGroups"];
const aeSpec = (events?: "seriousEvents" | "otherEvents"): SectionSpec => ({
  fields: [...aeContext, ...(events ? [events] : [])].map(k => `${aeBase}.${k}`),
  select: s => at(s, ["resultsSection", "adverseEventsModule"]),
  note: "保留eventGroups中的组别ID与分母。实际分析集、timeFrame及频率阈值以本模块原文为准；人数和事件次数不能混用。",
});

export const sections: Record<StudyInput["section"], SectionSpec> = {
  overview: {
    fields: ["OverallStatus", "Phase", "StudyType", "EnrollmentInfo", "StartDateStruct", "PrimaryCompletionDateStruct", "CompletionDateStruct", "LeadSponsorName"],
    select: s => ({ ...s, supportedSections: [...sectionNames] }),
    note: "这是按需读取的入口，不包含完整研究。supportedSections是可请求的模块，不保证该研究每个模块都有数据。",
  },
  design: protocol("designModule", "DesignModule", "enrollmentInfo是注册总入组人数及ACTUAL/ESTIMATED属性；不代表各治疗组实际人数。"),
  arms: protocol("armsInterventionsModule", "ArmsInterventionsModule", "方案治疗组、干预措施和剂量；实际各组人数需另读participant_flow。"),
  eligibility: protocol("eligibilityModule", "EligibilityModule", "保留入排标准原文。"),
  primary_outcomes: { fields: ["PrimaryOutcome"], select: s => at(s, ["protocolSection", "outcomesModule", "primaryOutcomes"]), note: "这是方案规定的主要终点与时间窗，不是试验结果。实测结果先读results_index，再读outcome_result。" },
  secondary_outcomes: { fields: ["SecondaryOutcome", "OtherOutcome"], select: s => at(s, ["protocolSection", "outcomesModule"]), note: "这是方案中的次要/其他终点定义，不是试验结果。" },
  locations: { fields: ["LocationFacility", "LocationCity", "LocationState", "LocationCountry", "LocationStatus"], select: s => at(s, ["protocolSection", "contactsLocationsModule", "locations"]), note: "只取中心名称、城市、地区、国家和状态；不拉取个人联系人。缺少地点不能自动判断为单国研究。" },
  references: { fields: ["ReferencesModule", "LargeDocumentModule"], select: s => ({ references: at(s, ["protocolSection", "referencesModule"]) ?? null, documents: at(s, ["documentSection", "largeDocumentModule"]) ?? null }), note: "引用和公开文档入口；列有引用不表示已读取其全文。" },
  results_index: {
    fields: ["OutcomeMeasureType", "OutcomeMeasureTitle", "OutcomeMeasureTimeFrame"],
    select: s => arr(at(s, ["resultsSection", "outcomeMeasuresModule", "outcomeMeasures"])).map((v, i) => ({ outcomeIndex: i, ...obj(v) })),
    note: "结果终点目录，含原始0起始索引；标题或类型为PRIMARY不等于已读取数值。用outcome_result和outcomeIndex取对应完整结果。",
  },
  participant_flow: moduleSpec("resultsSection", "participantFlowModule", "ParticipantFlowModule", "实际受试者流程；按groups.id连接各period的STARTED/COMPLETED等人数，不能与方案分组按位置强行对应。"),
  baseline: moduleSpec("resultsSection", "baselineCharacteristicsModule", "BaselineCharacteristicsModule", "基线特征及其分析集、组别和分母；可能与随机人数不同。"),
  outcome_result: {
    fields: ["OutcomeMeasuresModule"],
    select: (s, input) => {
      const measures = arr(at(s, ["resultsSection", "outcomeMeasuresModule", "outcomeMeasures"]));
      if (input.outcomeIndex === undefined) throw new ScoutError("MISSING_OUTCOME_INDEX", "先读results_index，再填写其outcomeIndex。");
      if (input.outcomeIndex >= measures.length) throw new ScoutError("OUTCOME_INDEX_OUT_OF_RANGE", "终点索引不存在；请重新获取results_index。", false, { availableOutcomeCount: measures.length });
      return measures[input.outcomeIndex];
    },
    note: "仅返回指定终点；保留组别、分析集、单位、时间点、分母、数值与统计分析。上游API按整个结果模块取回，Worker再按索引选择；不声称API支持数组元素服务器端分页。",
  },
  adverse_events_summary: aeSpec(),
  serious_events: aeSpec("seriousEvents"),
  other_events: aeSpec("otherEvents"),
};

export class ScoutService {
  constructor(private client = new ClinicalTrialsClient()) {}

  async getStudy(input: StudyInput): Promise<Obj> {
    if (input.section !== "outcome_result" && input.outcomeIndex !== undefined) throw new ScoutError("UNEXPECTED_OUTCOME_INDEX", "outcomeIndex仅用于outcome_result模块。");
    if (input.section === "outcome_result" && input.outcomeIndex === undefined) throw new ScoutError("MISSING_OUTCOME_INDEX", "先读results_index，再填写outcomeIndex。");
    const spec = sections[input.section];
    const params = new URLSearchParams({ fields: [...new Set([...identityFields, ...spec.fields])].join(",") });
    const { data: record, url } = await this.client.get(`/studies/${input.nctId}`, params);
    if (at(record, ["protocolSection", "identificationModule", "nctId"]) !== input.nctId) throw new ScoutError("RECORD_MISMATCH", "返回记录编号与请求不符，已停止处理。");
    const lastUpdate = at(record, ["protocolSection", "statusModule", "lastUpdatePostDateStruct", "date"]) ?? null;
    if (input.expectedLastUpdate && input.expectedLastUpdate !== lastUpdate) throw new ScoutError("SOURCE_CHANGED", "注册库更新时间与前一模块不同，请重新读取。", false, { expected: input.expectedLastUpdate, actual: lastUpdate });
    const selected = spec.select(record, input);
    const missing = selected === undefined || selected === null || (Array.isArray(selected) && selected.length === 0) || (typeof selected === "object" && selected !== null && !Array.isArray(selected) && Object.values(selected).every(v => v === null));
    const page = await pageData(selected ?? null, `${input.nctId}:${input.section}:${input.outcomeIndex ?? ""}`, lastUpdate, input.cursor);
    return {
      ok: true, operation: "getStudyByNCT", nctId: input.nctId, section: input.section, outcomeIndex: input.outcomeIndex ?? null,
      source: { studyUrl: `https://clinicaltrials.gov/study/${input.nctId}`, apiUrl: url, retrievedAt: new Date().toISOString(), lastUpdate },
      hasResults: record.hasResults ?? null,
      availability: missing ? "not_in_registry_record" : "present_in_registry_record",
      note: spec.note,
      evidenceBoundary: "字段缺失只说明本次注册库记录未提供；仍需文献/会议/公司披露补检。响应仅覆盖请求的模块；未返回的模块不是未公开。",
      ...page,
    };
  }

  async search(input: SearchInput): Promise<Obj> {
    if (![input.queryIntr, input.queryCond, input.querySpons, input.queryTerm].some(Boolean)) throw new ScoutError("QUERY_REQUIRED", "至少提供药物、疾病、申办方或关键词，避免无条件抓取全库。");
    const query: Obj = {
      queryIntr: input.queryIntr ?? null, queryCond: input.queryCond ?? null,
      querySpons: input.querySpons ?? null, queryTerm: input.queryTerm ?? null,
      phases: [...new Set(input.phases ?? [])].sort(), statuses: [...new Set(input.statuses ?? [])].sort(), sort: input.sort, view: input.view,
    };
    const fingerprint = await digest(query);
    let upstreamToken: string | undefined;
    let retrievedCount = 0;
    let initialTotalCount: number | null = null;
    if (input.pageToken) {
      const token = tokenDecode(input.pageToken);
      if (token.v !== 2 || token.query !== fingerprint || typeof token.upstream !== "string" || !Number.isSafeInteger(token.retrievedCount) || Number(token.retrievedCount) < 0 || (token.totalCount !== null && (!Number.isSafeInteger(token.totalCount) || Number(token.totalCount) < 0))) throw new ScoutError("CURSOR_SCOPE_MISMATCH", "检索翻页必须保持相同条件、排序与view；请使用当前版本工具返回的nextPageToken。");
      upstreamToken = token.upstream;
      retrievedCount = Number(token.retrievedCount);
      initialTotalCount = token.totalCount as number | null;
    }
    const allowance = input.allowBeyond200 ? input.remainingBeforePause : Math.min(input.remainingBeforePause, Math.max(0, 200 - retrievedCount));
    if (allowance === 0) throw new ScoutError("SCREENING_CHECKPOINT", "已到200条候选摘要取回暂停点；未请求上游、未读取剩余研究。先分别报告总命中、取回数、唯一NCT数、实际筛选数及待读数；若没有逐条纳排判定记录，实际筛选数写未核实。仅用户同意继续后恢复。", false, { retrievedCount, screenedCount: null, screeningStatus: "not_verified_by_mcp", totalCount: initialTotalCount, nextPageToken: input.pageToken ?? null, requiresUserDecision: true });
    let size = Math.min(input.pageSize, allowance);
    for (;;) {
      const params = new URLSearchParams({ pageSize: String(size), countTotal: "true", sort: input.sort, fields: input.view === "ids" ? "NCTId" : "NCTId,BriefTitle,OverallStatus,Phase,HasResults,LastUpdatePostDate" });
      for (const [key, name] of [["queryIntr", "query.intr"], ["queryCond", "query.cond"], ["querySpons", "query.spons"], ["queryTerm", "query.term"]] as const) {
        if (input[key]) params.set(name, input[key]);
      }
      if (input.phases?.length) params.set("filter.advanced", `AREA[Phase](${[...new Set(input.phases)].join(" OR ")})`);
      if (input.statuses?.length) params.set("filter.overallStatus", [...new Set(input.statuses)].join(","));
      if (upstreamToken) params.set("pageToken", upstreamToken);
      const { data: result } = await this.client.get("/studies", params);
      if (!Array.isArray(result.studies)) throw new ScoutError("UPSTREAM_SCHEMA_ERROR", "注册库检索响应缺少studies数组；未将其当作零结果。");
      if (result.studies.length > size) throw new ScoutError("UPSTREAM_SCHEMA_ERROR", "注册库返回条数超过本次请求额度；停止处理，未静默删减候选。");
      const studies = result.studies.map(study => {
        const id = at(study, ["protocolSection", "identificationModule", "nctId"]);
        if (typeof id !== "string" || !/^NCT\d{8}$/.test(id)) throw new ScoutError("UPSTREAM_SCHEMA_ERROR", "检索候选缺少有效NCT编号。");
        if (input.view === "ids") return { nctId: id };
        return {
          nctId: id, title: at(study, ["protocolSection", "identificationModule", "briefTitle"]) ?? null,
          status: at(study, ["protocolSection", "statusModule", "overallStatus"]) ?? null,
          phases: at(study, ["protocolSection", "designModule", "phases"]) ?? null,
          lastUpdate: at(study, ["protocolSection", "statusModule", "lastUpdatePostDateStruct", "date"]) ?? null,
          hasResults: obj(study).hasResults ?? null,
        };
      });
      if (bytes(studies) > DATA_BUDGET) {
        if (size === 1) throw new ScoutError("SEARCH_ITEM_TOO_LARGE", "单项候选摘要仍过大，请从第一页改用view=ids。未丢弃候选或截断正文。");
        size = Math.max(1, Math.floor(size / 2));
        continue;
      }
      const next = result.nextPageToken;
      if (next !== undefined && (typeof next !== "string" || !next.length)) throw new ScoutError("UPSTREAM_SCHEMA_ERROR", "注册库分页标记格式异常。");
      if (!input.pageToken) {
        const total = result.totalCount;
        if (total !== undefined && total !== null && (!Number.isSafeInteger(total) || Number(total) < 0)) throw new ScoutError("UPSTREAM_SCHEMA_ERROR", "注册库总命中数格式异常，未推算剩余数量。");
        initialTotalCount = typeof total === "number" ? total : null;
      }
      const cumulativeRetrievedCount = retrievedCount + studies.length;
      const reachedCheckpoint = (!input.allowBeyond200 && cumulativeRetrievedCount >= 200) || studies.length >= input.remainingBeforePause;
      return {
        ok: true, operation: "searchStudies", query, source: { apiBase: API_BASE, retrievedAt: new Date().toISOString() },
        studies: studies as Json, totalCount: initialTotalCount, returnedCount: studies.length,
        requestedPageSize: input.pageSize, effectivePageSize: size,
        hasMore: typeof next === "string", nextPageToken: typeof next === "string" ? tokenEncode({ v: 2, query: fingerprint, upstream: next, retrievedCount: cumulativeRetrievedCount, totalCount: initialTotalCount }) : null,
        screening: {
          initialLimit: 200,
          cumulativeRetrievedCount,
          retrievalStatus: "candidate_summaries_retrieved",
          screenedCount: null,
          screeningStatus: "not_verified_by_mcp",
          countBasis: "cumulativeRetrievedCount只是本查询累计取回记录数，未跨页或跨查询去重；不得直接写为实际完成初筛数或分析数。",
          screenedCountRule: "只有调用方逐条应用明确纳排标准并记录纳入、排除或待定判定后，才能另行报告实际筛选数；MCP本身无法核实该数字。",
          checkpointReached: reachedCheckpoint,
          requiresUserDecision: reachedCheckpoint && typeof next === "string",
          nextAction: reachedCheckpoint ? "先报告阶段结果和覆盖范围；有剩余或待查别名时等待用户选择，再继续或调整条件。" : "在剩余取回额度内继续读取；跨查询也累计，最多先取回200条候选摘要。",
        },
        pageComplete: true,
        note: "默认每页20项，先取回最多200条候选摘要；超过200条先不读取其余候选，分别告知接口总命中、候选摘要取回数、唯一NCT数、实际筛选数、深度分析数和未读取数。每次调用跟踪跨查询remainingBeforePause，不因新增别名重置额度。仅用户已要求全量或同意继续时allowBeyond200=true。单查询累计是返回记录数；去重由调用方统计，实际筛选数必须有明确标准和逐条判定记录，否则写未核实；多个查询总数不能相加。保留首查totalCount和续页标记，字段精简不是候选抽样。",
        coverage: "最后一页只表示本次查询到达末页，不证明所有别名、多库或其他来源已检索。注册库不提供本工具可保证的跨页固定快照，应按NCT去重并核对更新。",
      };
    }
  }
}
