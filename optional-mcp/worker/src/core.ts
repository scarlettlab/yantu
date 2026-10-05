export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Obj = { [key: string]: Json };
export const API_BASE = "https://clinicaltrials.gov/api/v2";
export const DATA_BUDGET = 12_000;
export const TOOL_RESULT_LIMIT = 48_000;
export const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
export const obj = (value: Json | undefined): Obj => value && typeof value === "object" && !Array.isArray(value) ? value : {};
export const arr = (value: Json | undefined): Json[] => Array.isArray(value) ? value : [];
export const at = (value: Json, path: string[]): Json | undefined => path.reduce<Json | undefined>((v, key) => obj(v)[key], value);

export class ScoutError extends Error {
  constructor(public code: string, message: string, public retryable = false, public details: Obj = {}) {
    super(message);
  }
}

export async function digest(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(x => x.toString(16).padStart(2, "0")).join("");
}

export function tokenEncode(value: unknown): string {
  const data = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function tokenDecode(value: string): Obj {
  try {
    if (value.length > 6000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const text = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const data: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(text, c => c.charCodeAt(0))));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Obj;
  } catch {
    throw new ScoutError("INVALID_CURSOR", "继续读取标记无效。请从第一页重新读取。");
  }
}

export function toolResult(payload: Obj, isError = false) {
  // Both forms are provided for clients that only display text. Bound the complete envelope.
  const result = { isError, structuredContent: payload, content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
  if (bytes(result) > TOOL_RESULT_LIMIT) {
    return toolResult({ ok: false, error: { code: "OUTPUT_BUDGET_EXCEEDED", message: "响应元数据超出限制；请缩短检索条件或改用ids视图。没有将部分结果伪装为完整结果。", retryable: false } }, true);
  }
  return result;
}

export async function runTool(work: () => Promise<Obj>) {
  try { return toolResult(await work()); }
  catch (e) {
    const error = e instanceof ScoutError ? e : new ScoutError("INTERNAL_ERROR", "工具处理失败；本次没有获得可用于结论的完整响应。");
    return toolResult({ ok: false, error: { code: error.code, message: error.message, retryable: error.retryable, ...error.details } }, true);
  }
}
