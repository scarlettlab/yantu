# 第三方内容与运行依赖

本声明按分发包中实际包含的组件适用；某个独立技能不需要的依赖，无需为此安装。研途许可适用于项目自身材料，第三方内容适用各自条款。

## 数据和专业资料

ClinicalTrials.gov 及其他外部来源的数据适用其提供方的条款。运行脚本获取的数据保存在使用者指定的任务目录。

文献、监管文件、专业词典和项目模板须按适用权限访问。涉及 CTCAE 分级、MedDRA 编码或其他版本化标准时，使用项目适用且获授权的资料；提及标准或产品名称不授予其数据使用或再分发权。

## Python 直连脚本

Scout 的 ClinicalTrials 脚本使用 Python 标准库。Python 解释器由运行环境提供。

## 可选 MCP 服务

可选 Worker 通过 npm 安装依赖；基础技能运行不要求安装这些依赖。直接依赖为：

| 依赖 | 版本 | 许可 |
|---|---|---|
| @modelcontextprotocol/server | 2.0.0 | MIT |
| agents | 0.24.0 | MIT |
| zod | 4.6.5 | MIT |

开发工具包括 TypeScript（Apache-2.0）、tsx（MIT）、Wrangler（MIT OR Apache-2.0）等。完整版本树见源码包中的 `optional-mcp/worker/package-lock.json`；各组件的许可文本以其发行包为准。

## Excel 参考生成器

Scout 的 `build_excel_report.mjs` 调用运行环境提供的 `@oai/artifact-tool` 和 `jszip`，研途分发包提供调用脚本。相关库适用其自身许可；环境未提供这些库时，可通过其他电子表格工具按同一交付规范生成文件。
