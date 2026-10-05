import { z } from "zod";

const query = z.string().trim().min(1).max(300).optional();
export const searchSchema = z.object({
  queryIntr: query.describe("药物或干预措施；对应query.intr。"),
  queryCond: query.describe("疾病或适应症；对应query.cond。"),
  querySpons: query.describe("申办方；对应query.spons。"),
  queryTerm: query.describe("其他关键词/试验代号；对应query.term。"),
  phases: z.array(z.enum(["EARLY_PHASE1", "PHASE1", "PHASE2", "PHASE3", "PHASE4", "NA"])).min(1).max(6).optional(),
  statuses: z.array(z.enum(["RECRUITING", "NOT_YET_RECRUITING", "ACTIVE_NOT_RECRUITING", "ENROLLING_BY_INVITATION", "COMPLETED", "TERMINATED", "SUSPENDED", "WITHDRAWN", "UNKNOWN"])).min(1).max(9).optional(),
  sort: z.enum(["LastUpdatePostDate:desc", "StartDate:asc"]).default("LastUpdatePostDate:desc"),
  view: z.enum(["summary", "ids"]).default("summary"),
  pageSize: z.number().int().min(1).max(50).default(20).describe("单次请求默认20项、最多50项。默认先取回最多200条候选摘要后暂停；这是单页大小，不是总命中数，也不是已筛选数。"),
  remainingBeforePause: z.number().int().min(0).max(200).default(200).describe("本轮任务距离200条候选摘要取回暂停点还可读取多少条；跨别名查询也须累计，临近暂停点时传实际剩余额度，0表示不得再读。"),
  allowBeyond200: z.boolean().default(false).describe("仅用户明确要求全量或同意继续时设true；否则默认累计取回200条候选摘要即暂停。无状态服务的跨查询额度由调用方跟踪。"),
  pageToken: z.string().min(1).max(6000).optional().describe("原样传入工具返回的nextPageToken；其他查询条件和view保持一致。"),
}).strict();

export const sectionNames = ["overview", "design", "arms", "eligibility", "primary_outcomes", "secondary_outcomes", "locations", "references", "results_index", "participant_flow", "baseline", "outcome_result", "adverse_events_summary", "serious_events", "other_events"] as const;
export const studySchema = z.object({
  nctId: z.string().regex(/^NCT\d{8}$/).describe("NCT加8位数字，例如NCT03548935。"),
  section: z.enum(sectionNames).default("overview").describe("每次读一个模块。人数/实际分组用participant_flow；计划主要终点用primary_outcomes；实测结果先results_index再outcome_result。"),
  outcomeIndex: z.number().int().min(0).max(10000).optional().describe("outcome_result必填，来自results_index，0起始；其他模块不要填。"),
  expectedLastUpdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("跨模块读取时传入overview的lastUpdate，检测注册库更新。"),
  cursor: z.string().min(1).max(6000).optional().describe("原样传入本模块的nextCursor；直到sectionComplete=true。"),
}).strict();

export type SearchInput = z.infer<typeof searchSchema>;
export type StudyInput = z.infer<typeof studySchema>;
