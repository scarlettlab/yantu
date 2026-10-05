# 可选 MCP 适配

研究策略和质量规则统一以 data-access.md 及模式参考文件为准。MCP 是可选访问通道，不依赖作者私人应用、连接 ID 或服务器。

使用者已有兼容 MCP 时发现 searchStudies / getStudyByNCT（名称可能带平台前缀）。没有这些工具就报告能力缺口，按 data-access.md 采用直接脚本或限定资料，不要求全套安装。

- searchStudies：queryIntr / queryCond / querySpons / queryTerm；pageSize 默认 20、最多 50。未限定阶段或状态时不传过滤。仅需要阶段限制时用实际 schema 的 phases，不沿用旧 filter.phase 参数。
- 沿 nextPageToken 翻页，保持查询条件、排序、view 一致；不能把 MCP 包装的 token 传给官方 API，也不能混用两条通道的 token。
- 调用方跨查询维护 remainingBeforePause，默认任务累计 200 条暂停；明确全量或继续授权才 allowBeyond200=true。参数额度是取回额度，不是医学筛选结果。
- getStudyByNCT：nctId、section；先 overview、按实际返回传 expectedLastUpdate。结果先 results_index，再 outcome_result + outcomeIndex。
- 大模块沿 nextCursor，保持 NCT、section、outcomeIndex 和 expectedLastUpdate，至 sectionComplete=true 且无 nextCursor。核对 startEntry/endEntryExclusive 连续。JSON Pointer 页的叶子条目数不等于人数、事件数或终点数。
- SOURCE_CHANGED 需重读；SCREENING_CHECKPOINT 是暂停；availability=not_in_registry_record 仅表示本次字段缺失。失败和未公开不能混用。

可选服务源码、配置范例和部署说明位于完整仓库的 optional-mcp/。单独安装本技能不需要这些文件；可在来源仓库获取，不能假定其存在于单技能文件夹中。
