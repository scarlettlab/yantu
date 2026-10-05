# 让 AI 通过 MCP 读取 ClinicalTrials.gov

如果你的 AI 无法用随包 Python 脚本直接读取 ClinicalTrials.gov，可以配置一个 MCP 连接。它提供两项能力：搜索研究，以及读取指定研究的设计和结果。

已有兼容连接时可直接使用。如果没有，worker/ 提供了一个可部署到 Cloudflare Workers 的服务。下面的步骤需要一个 Cloudflare 账号和 Node.js 22+，适合愿意自行配置服务的使用者。

## 自行部署

1. 打开 `worker/wrangler.jsonc`，把 name 改成账号中尚未使用的名称。
2. 在 worker/ 目录运行 `npm ci` 安装依赖，再运行 `npm run check`、`npm test` 和 `npm run build`。build 只检查本地打包。
3. 用 `npx wrangler login` 登录，再运行 `npm run deploy` 部署到自己的账号。
4. 从部署结果取得实际 HTTPS 地址，在地址末尾加上 `/mcp`。
5. 在 AI 客户端的 MCP 连接设置中填写该地址。客户端采用配置文件时，可参考 `mcp.example.json`，填入自己的真实地址。
6. 先用小查询确认可以搜索、翻页和读取单项研究，再开始正式取数。

是否能添加 MCP 连接取决于客户端和账号权限。账号凭证应保存在部署工具或服务端设置中。

## 部署前需要知道

此示例没有内置登录认证。知道服务地址的人可以调用它，并消耗部署账号的资源。准备共享服务地址时，应先设置适合使用范围的访问控制和限流。

## 数据怎么返回？

搜索默认每页 20 条，最多 50 条。默认累计取回 200 条候选记录后确认是否继续，用户明确要求全量时可继续。

单项研究按模块读取，例如设计、主要终点、疗效结果或不良事件。较大的模块会分成多页，需要沿续页标记读完。查询参数与注册更新时间也会被检查，帮助发现条件改变或数据版本变化。

共同取数要求见 [data-access.md](../skills/yantu-scout/references/data-access.md)。

## 文件说明

| 文件或目录 | 用途 |
|---|---|
| `mcp.example.json` | 客户端连接地址的填写示例 |
| `worker/wrangler.jsonc` | Cloudflare 服务名称和部署设置 |
| `worker/package.json` | 依赖与运行命令 |
| `worker/package-lock.json` | 锁定依赖版本，帮助重复安装 |
| `worker/src/` | 搜索、研究读取、分页和错误处理的程序 |
| `worker/test/` | 程序测试 |
| `worker/scripts/` | 连接检查与数据比较工具 |
