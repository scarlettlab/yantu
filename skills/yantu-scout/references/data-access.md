# ClinicalTrials 共同取数规则

本文件是直连与 MCP 共用的质量要求。三轮、多别名、多来源、纳入和字段要求仍按 Scout 方法参考执行；更换传输方式不减少这些要求。

## 能力选择

1. 若当前宿主能运行随包 Python 且允许官方 HTTPS，先用 `scripts/clinicaltrials.py --mode probe` 检查两页及详情。已有本轮有效验证可复用，不每次重新探测。脚本用 Python 3.9+ 标准库，需将同目录 clinicaltrials_fields.py 一起保留。
2. 直连可用时默认采用脚本；用户已指定并可用的 MCP 可沿用。直连失败时如实保留失败类型，再使用用户已配置的兼容 MCP，不绑定或要求连接作者私人应用。
3. 没有可用直连或 MCP 时，仍可用宿主实际可访问的网页、论文和用户导出数据做限定调研。说明缺少连续分页/注册字段等覆盖，不能声称系统注册库取数完成；不强制用户部署 Worker 才开始任务。
4. 技能安装不授予执行或网络权限。不改代理、不关闭 TLS 校验、不绕过宿主限制。网页工具读到 JSON 与代码环境联网分开判断。执行工具只能读取随包资源而没有路径时，可原样复制完整脚本及同目录模块到当前可写目录，再运行并说明。

## 搜索和候选额度

将 `<脚本>` 替换为当前宿主实际可访问的 scripts/clinicaltrials.py；`<任务目录>` 为本次研究的可写输出目录。不要使用下面的占位符作为实际值。

```sh
python3 "<脚本>" --mode probe --out "<任务目录>/probe"
python3 "<脚本>" --mode search --intervention semaglutide --out "<任务目录>"
python3 "<脚本>" --mode search --sponsor "Example Sponsor" --out "<任务目录>"
```

- `--intervention/--condition/--sponsor/--term` 对应 query.intr/cond/spons/term。各维度按策略分开检索取并集；同时传多个参数会形成联合条件，仅在任务需要时使用。
- 直连默认每页 100；MCP 默认每页 20、最多 50。页面大小是传输批次，不改变研究范围。默认均在本任务累计取回 200 条候选记录后暂停，重复记录也消耗取回额度。
- 直连同一 `--out` 下维护 retrieval-session.json，跨别名/查询共享额度，禁止为越过暂停点另建任务目录。MCP 跨查询由调用者维护 remainingBeforePause。同一任务不要在两条通道分别重新开始 200 条额度；切换时把共同剩余额度传给新通道。
- 只有用户明确要求全量或同意继续时，直连加 `--allow-beyond-200`；MCP 设置 allowBeyond200=true。用户只同意小批时还要传 `--remaining-before-pause N` 或 remainingBeforePause=N。已有明确授权无需重复询问。
- 使用 `--max-pages` 设置本次操作上限，默认 10；全量请求可用较高值，例如 100。到上限且仍有 token 必须报告未完成，不默默丢弃后续页。
- 对已有未消费 token 的 report.json，续取用 `--mode search --resume-report "<报告路径>" --out "<同一任务目录>"`，有继续授权时加上述标志。此操作沿用原查询；后续分段本身不会被标为完整，需合并各段 studies.json 并按 NCT 去重，核对总数、token 连续性和更新时间。
- 页间条件与排序保持一致，读取真实 nextPageToken；报告实际请求数、各页条数、唯一 NCT、重复/异常、总命中、停止原因。totalCount 缺失不记为 0。
- 区分接口总命中、候选取回数、唯一 NCT 数、实际筛选数、深度分析数和未读取数。没有明确标准和逐条判定记录，筛选数为“未核实”。候选主表保留与最终模式纳入规则按原方法执行，不让工具自行排除研究。

全量授权调用示例：

```sh
python3 "<脚本>" --mode search --intervention semaglutide --page-size 100 --max-pages 100 --allow-beyond-200 --out "<任务目录>"
```

## 单研究与医学字段

```sh
python3 "<脚本>" --mode study --nct NCT03548935 --section overview --out "<任务目录>"
python3 "<脚本>" --mode study --nct NCT03548935 --section results_index --out "<任务目录>"
python3 "<脚本>" --mode study --nct NCT03548935 --section outcome_result --outcome-index 0 --expected-last-update "<overview中实际日期>" --out "<任务目录>"
```

overview → 按需要读 design/arms/eligibility/primary_outcomes/secondary_outcomes/locations/references；结果先 results_index，再 outcome_result；实际人数读 participant_flow，基线读 baseline，安全性按 adverse_events_summary/serious_events/other_events。

直连每次保存完整研究响应，再无损提取指定 section 到 section.json；也可直接解析本次已保存的同一版本完整 JSON，不重复下载。MCP 按 section 取数，大模块必须沿 nextCursor 到 sectionComplete=true。两条路径均不能用摘要代替正式数据，不应把巨型原始文件一次塞进对话上下文。

- 保留 groupId、分析集、分母、单位、时间点、估计值/区间/P 值及 ACTUAL/ESTIMATED；不按数组位置猜组别对应。
- Enrollment 总数不代替各组 STARTED；primary_outcomes 为定义，不是实测结果。
- 按实际 source_last_update / source.lastUpdate 保持版本；版本变化需重读相关部分，不能混用。
- 文件完整保存不等于模型已分析所有字段；报告已读取模块与未分析部分。

## 输出和失败

脚本输出唯一运行子目录、report.json、requests.json、原始响应、studies.json/CSV 或 section.json。原始响应字节与 SHA-256 分开保留；CSV 仅是简表，不代替完整 JSON。退出码 2 可表示技术失败、达到暂停点或不完整，先读报告再解释。

DNS/权限/超时、HTTP 错误、未读取、字段缺失、未公开分别标识；404 不推断研究撤回，空页有 token 仍继续。注册库缺失不能代替论文/会议/监管/公司补检。无末页证据、存在缺页或范围未覆盖时，不使用“全面完成”。

正常退出释放检索锁。若宿主中断，保留 report/requests/checkpoint 与 ledger，先检查是否有进行中的进程和最后一次响应；不要为了重试直接重置计数或删除证据。程序不提供并行共享同一任务目录的检索。
