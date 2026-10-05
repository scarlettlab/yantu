# 安装与使用

## 选择下载内容

| 你的需求 | 选择的文件 | 解压后的入口 |
|---|---|---|
| 使用某一个技能 | `yantu-技能名-1.0.0.zip` | `yantu-技能名/README.md` |
| 使用整套插件 | `yantu-plugin-1.0.0.zip` | `yantu/plugin.json` |
| 查看、修改或自行构建 | `yantu-source-1.0.0.zip` | `yantu/README.md` |

技能短名为 atlas、scout、guide、trace、frame、draft。选择同一版本的文件；`SHA256SUMS.txt` 可用于核对下载内容。

## 安装单个技能

1. 解压对应 ZIP，得到一个 `yantu-技能名/` 文件夹。
2. 将整个文件夹放入客户端支持的技能目录。Codex 的用户技能目录为 `~/.agents/skills/`，项目级目录为项目中的 `.agents/skills/`；其他客户端按其文档设置。
3. 按客户端要求刷新或重新打开会话，检查技能是否出现。支持显式技能调用的客户端可输入 `$yantu-scout` 等名称，也可以直接描述适合该技能的任务。

文件夹中需保留 `SKILL.md`、随附资源和许可文件。README 面向使用者，SKILL.md 是 AI 执行任务时读取的工作指令。各技能可独立使用。

## 从源码安装一个或全部技能

在源码根目录运行（Python 3.9+）：

```sh
python3 scripts/install_skills.py --skill scout
```

默认安装到当前用户的 `~/.agents/skills/`。安装全部技能：

```sh
python3 scripts/install_skills.py --all
```

指定项目或其他客户端目录：

```sh
python3 scripts/install_skills.py --all --destination ./my-project/.agents/skills
```

将示例路径替换为实际目标。安装器复制技能与许可声明；已有同名目录时退出。升级前，先保存自己的修改，并将旧目录移到客户端技能扫描范围外，再安装新版本。卸载时删除对应的已安装技能目录；研究产出应保存在另行指定的任务目录。

## 安装整套插件

在支持相应格式的插件导入或创建流程中，选择整套插件 ZIP，按平台步骤完成安装。若平台要求先创建插件再获取安装入口，使用该流程生成的实际链接。

上传 ZIP 到普通聊天仅提供文件，不代表已完成插件安装。若账号没有插件入口，可使用平台支持的独立技能安装路径。技能安装不会自动授予网络、代码执行或第三方连接权限。

## 检查运行能力

**普通文本任务：** 确认 AI 已读取相应技能，并提供任务背景和必要资料。

**Scout 官方 API 直连：** 需要 Python 3.9+ 及访问 `clinicaltrials.gov` 的 HTTPS 权限。将下面的路径替换为已安装技能中的脚本路径：

```sh
python3 /path/to/yantu-scout/scripts/clinicaltrials.py --mode probe --out ./ct-check
```

该检查请求两页小样本及一项研究详情，在输出目录记录实际结果。运行失败时先查看 `report.json` 中的错误；是否能直连取决于当前执行环境。需要其他连接方式时，参考[可选 MCP](../optional-mcp/README.md)。

**Office 文件输出：** 使用平台已有文档/电子表格工具或 Python 库。Scout 的 `build_excel_report.mjs` 适用于提供 `@oai/artifact-tool` 和 `jszip` 的运行环境；缺少这些库时，按随包 Excel 规范使用其他可用工具。

## 自行构建分发包

在源码根目录运行：

```sh
python3 scripts/validate_release.py
python3 scripts/build_release.py
```

构建器在 `dist/` 生成源码包、整套插件包、六个独立技能包和 SHA-256 校验清单。`skills/` 是技能维护源；每个独立包还会附上根目录的许可与第三方声明。源码包与插件包当前包含相同内容，分别提供源码维护和插件导入入口。

[查看完整结构](CONTENTS.md) · [环境要求](COMPATIBILITY.md) · [使用许可](LICENSING.md)

格式依据：[OpenAI 技能文档](https://developers.openai.com/codex/skills)、[插件结构](https://developers.openai.com/plugins/build/plugins#plugin-structure)。客户端入口与权限以所用版本为准。
