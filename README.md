# MyAssistant

一个在本机常驻的私人助理。以 [pi](https://github.com/earendil-works/pi) 为核心 agent，具备：

- **RAG 历史聊天知识库**：SQLite + `sqlite-vec` + FTS5 混合检索
- **本地密钥库**：AES-256-GCM 加密 + macOS Keychain 解锁
- **钉钉聊天**：Stream Mode（无需公网 IP）
- **任务外派**：预留 `AgentDispatcher`，可派发给其它 agent

完整架构与路线图见 [`docs/PLAN.md`](docs/PLAN.md)。

## 环境要求

- Node.js >= 22.19
- npm >= 10（使用 npm workspaces）

> 仓库内置 `.npmrc` 使用 npmmirror 镜像以加速安装；如需官方源，删除该文件即可。

## 快速开始

```bash
npm install
cp .env.example .env
npm run dev
```

`npm run dev` 默认启动 REPL（当前为 M1–M4）。首次使用需要配置模型凭证：填入 `.env` 的 `MODEL_API_KEY`，或在本机运行过一次 `pi` 并用 `/login` 登录。

REPL 内置命令：`/help`、`/status`、`/new`、`/exit`。会话会自动持久化。

### 钉钉（Stream Mode）

在钉钉开放平台创建企业内部应用并添加 Stream 模式机器人，然后填入 `.env`：

```bash
DINGTALK_ENABLED=true
DINGTALK_CLIENT_ID=your-app-key
DINGTALK_CLIENT_SECRET=your-app-secret
DINGTALK_ROBOT_CODE=your-robot-code
```

启用后 `npm run dev` 进入钉钉模式（不再启动 REPL），收到的文本消息会转给 pi 并回复，每个会话使用独立的持久化 session。

RAG 会记录每轮对话并提供 `memory_search` 工具。默认使用 OpenAI 兼容的 embedding 接口，需配置 `RAG_EMBEDDING_API_KEY`（可选 `RAG_EMBEDDING_BASE_URL`）；本地调试可设 `RAG_EMBEDDING_PROVIDER=hash`。未配置凭证时 RAG 会自动跳过。

密钥库使用本地加密文件（AES-256-GCM，条目级 nonce + AAD），主密钥默认保存在 macOS Keychain，访问会写入审计日志（不记录值）。可用命令管理：

```bash
npm run vault -- set github_token --description "GitHub token"
npm run vault -- list
npm run vault -- get github_token
npm run vault -- rm github_token
```

Agent 可通过 `vault_get` / `vault_list` 工具访问密钥。CI 或非 macOS 环境可设置 `VAULT_MASTER_KEY`（base64 的 32 字节）或 `VAULT_PASSPHRASE`。

## 常用脚本

| 命令                | 说明                |
| ------------------- | ------------------- |
| `npm run dev`       | 启动 assistant      |
| `npm run vault`     | 管理本地密钥库      |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint`      | Biome 检查          |
| `npm run lint:fix`  | Biome 自动修复      |
| `npm test`          | Vitest 运行测试     |

## 目录结构

```
apps/assistant/          # daemon + CLI 入口
packages/
  config/                # zod 配置 schema 与加载
  core/                  # pi 会话装配、事件流、模型 provider
  rag/                   # 历史聊天知识库
  vault/                 # 加密密钥库
  channel-dingtalk/      # 钉钉 Stream 通道
  tasks/                 # 任务外派（AgentDispatcher）
docs/PLAN.md             # 架构与里程碑
```

## 当前进度

- [x] M0 脚手架
- [x] M1 核心对话
- [x] M2 RAG
- [x] M3 Vault
- [x] M4 钉钉
- [ ] M5 任务外派
- [ ] M6 加固

## 安全

密钥只应存放于 Vault；`.env` 仅用于启动引导配置，且已被 `.gitignore` 忽略。日志与配置摘要均不得包含明文密钥。
