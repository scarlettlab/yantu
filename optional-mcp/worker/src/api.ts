import { API_BASE, ScoutError, type Obj } from "./core";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;

export class ClinicalTrialsClient {
  constructor(
    private fetcher: Fetcher = (url, init) => fetch(url, init),
    private sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private timeoutMs = 12_000,
  ) {}

  async get(path: string, params: URLSearchParams): Promise<{ data: Obj; url: string }> {
    if (!/^\/studies(?:\/NCT\d{8})?$/.test(path)) throw new ScoutError("INVALID_PATH", "不支持的注册库路径。");
    params.set("format", "json");
    const url = `${API_BASE}${path}?${params}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetcher(url, { headers: { Accept: "application/json" }, signal: controller.signal });
        if (!response.ok) {
          const retryHeader = response.headers.get("retry-after");
          const parsed = retryHeader === null ? 1 : /^\d+$/.test(retryHeader) ? Number(retryHeader) : Math.ceil((Date.parse(retryHeader) - Date.now()) / 1000);
          const retryAfterSeconds = Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 86400)) : 1;
          await response.body?.cancel();
          if ((response.status === 429 || response.status >= 500) && attempt === 0 && retryAfterSeconds <= 2) {
            clearTimeout(timer);
            await this.sleep(retryAfterSeconds * 1000);
            continue;
          }
          const codes: Record<number, string> = { 400: "UPSTREAM_BAD_QUERY", 404: "STUDY_NOT_FOUND", 429: "RATE_LIMITED" };
          const message = response.status === 404 ? "该编号当前未返回研究记录；不能据此断言试验撤回。" : `注册库返回HTTP ${response.status}；不能将本次失败标为未公开。`;
          throw new ScoutError(codes[response.status] ?? "UPSTREAM_HTTP_ERROR", message, response.status === 429 || response.status >= 500, { httpStatus: response.status, retryAfterSeconds });
        }
        const reader = response.body?.getReader();
        if (!reader) throw new ScoutError("UPSTREAM_INVALID_JSON", "注册库响应体为空。");
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_UPSTREAM_BYTES) {
            await reader.cancel();
            throw new ScoutError("UPSTREAM_TOO_LARGE", "所选注册库模块超过8 MiB读取上限；请选更小模块。未返回截断数据。");
          }
          chunks.push(value);
        }
        const raw = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
        let data: unknown;
        try { data = JSON.parse(new TextDecoder().decode(raw)); }
        catch { throw new ScoutError("UPSTREAM_INVALID_JSON", "注册库未返回有效JSON。"); }
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new ScoutError("UPSTREAM_INVALID_JSON", "注册库响应结构错误。");
        return { data: data as Obj, url };
      } catch (e) {
        if (e instanceof ScoutError) throw e;
        throw new ScoutError(controller.signal.aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK_ERROR", "访问注册库超时或网络失败；请稍后重试。", true);
      } finally { clearTimeout(timer); }
    }
    throw new ScoutError("UPSTREAM_HTTP_ERROR", "注册库重试失败。", true);
  }
}
