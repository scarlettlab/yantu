# 文件夹里有什么？

每个技能是一个文件夹：README 给使用者看，SKILL.md 给 AI 读取。需要额外细则或程序的技能，还会有 references/ 和 scripts/ 等目录。

## 下载哪个包？

| 包 | 解压目录 | 用途 |
|---|---|---|
| yantu-source-1.0.0.zip | yantu/ | 看源码、修改和构建 |
| yantu-plugin-1.0.0.zip | yantu/ | 在支持的客户端导入整套插件 |
| yantu-atlas-1.0.0.zip | yantu-atlas/ | 独立安装 Atlas |
| yantu-scout-1.0.0.zip | yantu-scout/ | 独立安装 Scout |
| yantu-guide-1.0.0.zip | yantu-guide/ | 独立安装 Guide |
| yantu-trace-1.0.0.zip | yantu-trace/ | 独立安装 Trace |
| yantu-frame-1.0.0.zip | yantu-frame/ | 独立安装 Frame |
| yantu-draft-1.0.0.zip | yantu-draft/ | 独立安装 Draft |

源码包与插件包当前包含相同文件，安装入口不同。六个单技能包从同一套源码生成，另附使用许可和第三方声明。

## 六个独立技能

### 研途Atlas

[使用说明](../skills/yantu-atlas/README.md)

```text
yantu-atlas/
├── agents/
│   └── openai.yaml
├── LICENSE
├── README.md
├── SKILL.md
└── THIRD_PARTY_NOTICES.md
```

### 研途Scout

[使用说明](../skills/yantu-scout/README.md)

```text
yantu-scout/
├── agents/
│   └── openai.yaml
├── examples/
│   └── excel-style-sample.json
├── references/
│   ├── clinicaltrials-api-v3.6.1.txt
│   ├── data-access.md
│   ├── excel-delivery-v3.6.4.md
│   ├── general-rules-v3.6.1.txt
│   ├── landscape-modes-v3.6.1.txt
│   ├── mcp-workflow-v0.2.1.md
│   └── trial-modes-v3.6.1.txt
├── scripts/
│   ├── build_excel_report.mjs
│   ├── clinicaltrials.py
│   ├── clinicaltrials_fields.py
│   └── validate_excel_delivery.py
├── LICENSE
├── README.md
├── SKILL.md
└── THIRD_PARTY_NOTICES.md
```

### 研途Guide

[使用说明](../skills/yantu-guide/README.md)

```text
yantu-guide/
├── agents/
│   └── openai.yaml
├── LICENSE
├── README.md
├── SKILL.md
└── THIRD_PARTY_NOTICES.md
```

### 研途Trace

[使用说明](../skills/yantu-trace/README.md)

```text
yantu-trace/
├── agents/
│   └── openai.yaml
├── LICENSE
├── README.md
├── SKILL.md
└── THIRD_PARTY_NOTICES.md
```

### 研途Frame

[使用说明](../skills/yantu-frame/README.md)

```text
yantu-frame/
├── agents/
│   └── openai.yaml
├── LICENSE
├── README.md
├── SKILL.md
└── THIRD_PARTY_NOTICES.md
```

### 研途Draft

[使用说明](../skills/yantu-draft/README.md)

```text
yantu-draft/
├── agents/
│   └── openai.yaml
├── references/
│   ├── 02-医学写作术语参考-V0.7.md
│   ├── 03-证据与引用参考-V0.7.md
│   └── 04-医学写作QC参考-V0.7.md
├── LICENSE
├── README.md
├── SKILL.md
└── THIRD_PARTY_NOTICES.md
```

## 整套插件与源码

源码包和插件包的共同结构如下。dist/ 存放本地构建出的 ZIP，不嵌入包内；optional-mcp/ 是需要时自行配置的连接服务。

```text
yantu/
├── docs/
│   ├── COMPATIBILITY.md
│   ├── CONTENTS.md
│   ├── INSTALL.md
│   ├── LICENSING.md
│   └── VALIDATION.md
├── optional-mcp/
│   ├── worker/
│   │   ├── scripts/
│   │   │   ├── compare-fixture.ts
│   │   │   └── smoke.ts
│   │   ├── src/
│   │   │   ├── api.ts
│   │   │   ├── clinical.ts
│   │   │   ├── core.ts
│   │   │   ├── index.ts
│   │   │   ├── paging.ts
│   │   │   └── schemas.ts
│   │   ├── test/
│   │   │   └── scout.test.ts
│   │   ├── package-lock.json
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── wrangler.jsonc
│   ├── README.md
│   └── mcp.example.json
├── scripts/
│   ├── build_release.py
│   ├── install_skills.py
│   └── validate_release.py
├── skills/
│   ├── yantu-atlas/
│   │   ├── agents/
│   │   │   └── openai.yaml
│   │   ├── README.md
│   │   └── SKILL.md
│   ├── yantu-draft/
│   │   ├── agents/
│   │   │   └── openai.yaml
│   │   ├── references/
│   │   │   ├── 02-医学写作术语参考-V0.7.md
│   │   │   ├── 03-证据与引用参考-V0.7.md
│   │   │   └── 04-医学写作QC参考-V0.7.md
│   │   ├── README.md
│   │   └── SKILL.md
│   ├── yantu-frame/
│   │   ├── agents/
│   │   │   └── openai.yaml
│   │   ├── README.md
│   │   └── SKILL.md
│   ├── yantu-guide/
│   │   ├── agents/
│   │   │   └── openai.yaml
│   │   ├── README.md
│   │   └── SKILL.md
│   ├── yantu-scout/
│   │   ├── agents/
│   │   │   └── openai.yaml
│   │   ├── examples/
│   │   │   └── excel-style-sample.json
│   │   ├── references/
│   │   │   ├── clinicaltrials-api-v3.6.1.txt
│   │   │   ├── data-access.md
│   │   │   ├── excel-delivery-v3.6.4.md
│   │   │   ├── general-rules-v3.6.1.txt
│   │   │   ├── landscape-modes-v3.6.1.txt
│   │   │   ├── mcp-workflow-v0.2.1.md
│   │   │   └── trial-modes-v3.6.1.txt
│   │   ├── scripts/
│   │   │   ├── build_excel_report.mjs
│   │   │   ├── clinicaltrials.py
│   │   │   ├── clinicaltrials_fields.py
│   │   │   └── validate_excel_delivery.py
│   │   ├── README.md
│   │   └── SKILL.md
│   └── yantu-trace/
│       ├── agents/
│       │   └── openai.yaml
│       ├── README.md
│       └── SKILL.md
├── tests/
│   ├── ACCEPTANCE.md
│   ├── test_pagination.py
│   └── test_public_reader.py
├── .gitignore
├── CHANGELOG.md
├── LICENSE
├── README.md
├── THIRD_PARTY_NOTICES.md
└── plugin.json
```
