import { DATA_BUDGET, ScoutError, bytes, digest, tokenDecode, tokenEncode, type Json, type Obj } from "./core";

export type Entry = { path: string; value: Json; stringPart?: number; stringParts?: number };
const escapePointer = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");

// Preserve every leaf (including empty containers) and absolute array positions.
// Large strings are split by Unicode code points, never by UTF-16 surrogate halves.
export function entries(value: Json, path = ""): Entry[] {
  if (typeof value === "string" && [...value].length > 512) {
    const chars = [...value];
    const count = Math.ceil(chars.length / 512);
    return Array.from({ length: count }, (_, i) => ({ path, value: chars.slice(i * 512, (i + 1) * 512).join(""), stringPart: i + 1, stringParts: count }));
  }
  if (Array.isArray(value) && value.length) return value.flatMap((v, i) => entries(v, `${path}/${i}`));
  if (value !== null && typeof value === "object" && Object.keys(value).length) {
    return Object.keys(value).sort().flatMap(key => entries((value as Obj)[key], `${path}/${escapePointer(key)}`));
  }
  return [{ path, value }];
}

export async function pageData(data: Json, scope: string, sourceVersion: Json, cursor?: string): Promise<Obj> {
  const contentDigest = await digest([sourceVersion, data]);
  if (!cursor && bytes(data) <= DATA_BUDGET) {
    return { format: "json", data, digest: contentDigest, pageComplete: true, sectionComplete: true, nextCursor: null };
  }
  let start = 0;
  if (cursor) {
    const token = tokenDecode(cursor);
    if (token.v !== 1 || token.scope !== scope || typeof token.offset !== "number" || !Number.isSafeInteger(token.offset) || token.offset < 0) {
      throw new ScoutError("CURSOR_SCOPE_MISMATCH", "继续读取时必须使用相同研究编号、模块和终点索引。");
    }
    if (token.digest !== contentDigest) throw new ScoutError("SOURCE_CHANGED", "注册库内容或版本已变化；请从该模块第一页重新读取，避免混合版本。");
    start = token.offset;
  }
  const all = entries(data);
  if (start >= all.length) throw new ScoutError("INVALID_CURSOR", "继续读取位置超出模块范围。");
  const page: Entry[] = [];
  let length = 2;
  for (let i = start; i < all.length; i++) {
    const added = bytes(all[i]) + (page.length ? 1 : 0);
    if (length + added > DATA_BUDGET) break;
    page.push(all[i]); length += added;
  }
  if (!page.length) throw new ScoutError("ENTRY_TOO_LARGE", "单个字段路径超过响应上限；未返回截断数据。");
  const end = start + page.length;
  return {
    format: "json_pointer_entries", data: page as unknown as Json,
    digest: contentDigest, startEntry: start, endEntryExclusive: end, totalEntries: all.length,
    pageComplete: true, sectionComplete: end === all.length,
    nextCursor: end < all.length ? tokenEncode({ v: 1, scope, digest: contentDigest, offset: end }) : null,
    readingRule: "path为JSON Pointer，数组下标保持原值；同路径stringPart按编号拼接。必须取完本模块所有页后再总结；按groupId连接组别、分母及结果，禁止按位置猜测。sectionComplete只表示本模块读取完毕。",
  };
}
