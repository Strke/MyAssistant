# MyAssistant 架构与实施计划

> 一个在本机常驻的私人助理：以 pi 为核心 agent，具备历史聊天 RAG 知识库、本地密钥库、钉钉聊天接入，以及向其它 agent 外派任务的能力。

## 1. 目标与已定决策

| 维度       | 决策                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| 运行形态   | macOS 本机常驻进程（daemon）+ 本地 CLI / REPL，launchd 自启             |
| 核心 agent | `@earendil-works/pi-coding-agent` SDK（底层 `pi-agent-core` + `pi-ai`） |
| 钉钉接入   | Stream Mode（WebSocket 长连接，无需公网 IP）                            |
| 密钥库     | 本地加密文件 + macOS Keychain 解锁                                      |
| RAG 存储   | SQLite + `sqlite-vec` + FTS5 混合检索                                   |
| 任务外派   | `AgentDispatcher` 接口，后端可插拔（pi 子 agent / pi RPC / A2A）        |
| 包管理     | npm workspaces（Node ≥ 22.19）                                          |

## 2. 技术栈

- **语言/运行时**：TypeScript（ESM）、Node.js ≥ 22.19
- **Agent**：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-durable`
- **RAG**：`better-sqlite3`、`sqlite-vec`、SQLite FTS5、`drizzle-orm` 迁移
- **密钥库**：`@noble/ciphers`（AES-256-GCM）、`@noble/hashes`（Argon2id）、macOS Keychain
- **钉钉**：`dingtalk-stream`（入站）、`sessionWebhook` / OpenAPI（出站）
- **基础设施**：`zod`（配置校验）、`pino`（脱敏日志）、`vitest`（测试）、`biome`（lint/format）

## 3. 模块划分

```
apps/
  assistant/            # daemon 入口 + CLI(chat/vault/task) + REPL；装配一切
packages/
  config/               # zod 配置 schema 与加载（env / .env）
  core/                 # pi SDK 会话装配、事件流、system prompt、模型 provider
  rag/                  # 历史聊天知识库：存储 + 分块 + embedding + 混合检索 + 工具
  vault/                # 加密密钥库：解锁、增删改查、取用/占位符注入、审计
  channel-dingtalk/     # 钉钉 Stream 入站、去重、会话映射、出站回复
  tasks/                # AgentDispatcher 接口 + 后端实现（外派任务）
```

依赖方向：`config`（无依赖）→ 各能力包 → `core` 装配 → `apps/assistant`。能力包之间不互相直接依赖，通过 `core` 组合。

## 4. 关键设计

### 4.1 RAG 知识库（历史聊天）

选型理由：日常聊天是"带元数据的时序文本 + 向量"，SQLite 单文件便于备份、离线、零运维；加表加字段即可手动扩展，不被框架绑定。

**表结构（可扩展核心）**

- `conversations`：渠道 / 群 / 单聊
- `messages`：role、sender、channel、external_id、ts、原文、token 数
- `chunks`：message_id、seq、文本、embedding、metadata(JSON)
- `summaries`：按会话 / 时间窗口的滚动摘要
- 预留：`entities` / `edges`（人物、项目、事项关系图）、`tags`

**写入**：钉钉消息 + agent 每轮问答全部落库 → 异步分块 + embedding 入队。
**读取**：混合检索（`sqlite-vec` 语义 top-k + FTS5 关键词，中文用 trigram/jieba）→ 可选 rerank → 组装上下文。
**Agent 工具**：`memory_search(query, k, filters)`，并把短期摘要与检索结果注入 prompt。
**扩展点**：`RagStore` 接口 + SQL 迁移；后续可加实体抽取、知识图谱、reranker、换存储后端而不改核心。

### 4.2 密钥库（Vault）

- 存储：`vault.enc`，AES-256-GCM 加密；每条目独立 nonce + AAD。
- 主密钥：Argon2id 派生口令，或存 macOS Keychain；启动解锁，空闲自动锁定。
- 取用：`vault_get(name)` 工具；更安全模式为占位符注入（发 HTTP 请求时替换真值，agent 不见明文）。
- 审计：记录谁在何时取用了哪个 key（不记录值）；日志全程脱敏。
- 绝不入库、不入日志、不进 `.env`。

### 4.3 钉钉通道

- 入站：`dingtalk-stream` WebSocket，订阅机器人消息 topic，无需公网。
- 出站：优先 `sessionWebhook` 回复；需要主动推送时用 OpenAPI 按 conversationId。
- 特性：文本 / markdown、@、群聊 / 单聊、按 `msgId` 去重、每会话映射独立 pi session、后续支持流式预览。

### 4.4 任务外派（给其它 agent）

`AgentDispatcher` 接口：`delegate(task, target?)` / `poll(id)` / `cancel(id)`，默认异步。

- `PiSubagentBackend`：用 pi SDK fork / 新建独立 session 作为子 agent，隔离 workspace 执行，结果回推原聊天。
- `PiRpcBackend`：通过 pi RPC 派发给另一个 pi 进程 / agent。
- `HttpA2ABackend`（未来）：A2A 协议或自定义 webhook 派给外部 agent。
- 任务记录持久化；agent 工具 `delegate_task / check_task / cancel_task`；完成后回推钉钉会话。

### 4.5 进程模型

单个 daemon 持有 pi 会话、钉钉连接、RAG、vault、任务调度；本地 CLI 通过 localhost socket 控制；保留 REPL 调试；用 launchd LaunchAgent 自启。

## 5. 安全基线

- 密钥只进 vault；日志脱敏；危险工具二次确认。
- 钉钉消息去重与校验；RAG 检索内容视为不可信数据，防 prompt 注入。
- 数据库可选加密备份；最小权限运行。

## 6. 里程碑

| 里程碑          | 内容                                                                      | 验收                               |
| --------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| **M0 脚手架**   | workspace、TS、biome、vitest、config schema、`.env.example`、README、PLAN | `lint` / `typecheck` / `test` 全绿 |
| **M1 核心对话** | daemon + REPL，pi 会话持久化、流式输出、系统提示                          | 能和 agent 连续对话并持久化        |
| **M2 RAG**      | 建表/迁移、写入管线、混合检索、`memory_search`、历史回填                  | 能检索到历史聊天                   |
| **M3 Vault**    | 加密/解锁、Keychain、CLI、取用工具 + 脱敏 + 审计                          | 密钥可安全存取                     |
| **M4 钉钉**     | Stream 入站、出站回复、去重、会话映射、群/单聊                            | 钉钉可收发                         |
| **M5 任务外派** | Dispatcher 接口 + PiSubagent / PiRpc 后端 + 工具                          | 能把任务派给子 agent 并取回结果    |
| **M6 加固**     | 测试/e2e、限流、日志脱敏、launchd 自启、打包、文档                        | 可长期稳定运行                     |

## 7. 当前进度

- [x] M0 脚手架（本文件 + workspace + 工具链 + config + 模块骨架）
- [x] M1 核心对话（pi SDK 会话持久化 + REPL + 流式输出）
- [x] M2 RAG（SQLite + sqlite-vec + FTS5、写入管线、混合检索、memory_search 工具）
- [x] M3 Vault（AES-256-GCM 加密存储、Keychain/Env/Passphrase 主密钥、自动锁定、审计、vault 工具与 CLI）
- [x] M4 钉钉（Stream Mode 入站、去重、每会话独立 session、sessionWebhook 出站回复）
- [ ] M5 任务外派
- [ ] M6 加固
