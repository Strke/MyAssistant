# MyAssistant

一个在本机常驻的私人助理。以 [pi](https://github.com/earendil-works/pi) 为核心 agent，具备：

- **RAG 历史聊天知识库**：SQLite + `sqlite-vec` + FTS5 混合检索
- **本地密钥库**：AES-256-GCM 加密 + macOS Keychain 解锁
- **钉钉聊天**：Stream Mode（无需公网 IP）
- **任务外派**：持久化任务队列，可派发给子 agent / RPC / HTTP A2A
- **常驻守护进程**：Unix socket 本地控制、launchd 自启、结构化脱敏日志

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

`npm run dev` 默认启动 REPL（当前为 M1–M6）。首次使用需要配置模型凭证：填入 `.env` 的 `MODEL_API_KEY`，或在本机运行过一次 `pi` 并用 `/login` 登录。

REPL 内置命令：`/help`、`/status`、`/new`、`/exit`。会话会自动持久化。

### 模型账号接入

assistant 复用 pi 的模型运行时，支持三种接法，按自己的账号类型选一种即可。

#### 1. 订阅账号（Claude Pro/Max、ChatGPT Plus/Pro、Copilot 等）

不写 API Key，直接登录自己的订阅账号：

```bash
npm run login
```

在打开的 Pi 界面里输入 `/login`，选择 provider（例如 `Anthropic (Claude Pro/Max)` 或 `OpenAI (ChatGPT Plus/Pro)`），按提示在浏览器完成授权，然后 `/exit` 退出。

凭证由 pi 保存在 `~/.pi/agent/auth.json`，assistant 启动时会自动读取。支持哪些订阅以当前 pi 版本为准，已包含 Anthropic、OpenAI ChatGPT、GitHub Copilot、Kimi Code、xAI 等 OAuth 流程。

登录后先检查：

```bash
npm run model:check
```

它会列出当前可用的 provider/模型，并告诉你 `.env` 里配置的模型是否可用。订阅登录时注意：

- 不要同时设置 `MODEL_API_KEY`，运行时 Key 的优先级高于已保存的订阅凭证。
- 默认配置是 `anthropic/claude-sonnet-4-6`。如果登录的是 ChatGPT 或其它 provider，需要在 `.env` 改 `MODEL_PROVIDER` / `MODEL_ID`，具体值以 `model:check` 或 Pi 里的 `/model` 为准。
- 同一个 provider 同时只保存一份账号凭证；切换账号重新 `/login` 即可。

#### 2. 自己的 API Key

在 `.env` 里配置：

```bash
MODEL_PROVIDER=anthropic        # 或 openai / deepseek / google / moonshotai / openrouter ...
MODEL_ID=claude-sonnet-4-6
MODEL_API_KEY=sk-...
```

然后运行 `npm run model:check`，确认 `✅ configured model is available`。不同厂商的 Key 也可以放在对应环境变量里（如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`），不一定要写 `MODEL_API_KEY`。

#### 3. 本地或自建 OpenAI 兼容端点

在 `~/.pi/agent/models.json` 里配置 Ollama、LM Studio、vLLM 或自己的代理端点，然后设置：

```bash
MODEL_PROVIDER=ollama
MODEL_ID=qwen2.5-coder:7b
```

具体格式参考 pi 的 `models.json` 文档。配置好后同样用 `npm run model:check` 验证。

> `MODEL_API_KEY` 会进入 `.env`，该文件已被 git 忽略；如果你更希望把模型 Key 放进本地 Vault，可以告诉我，我再把 Vault 读取接进模型初始化流程。

### 钉钉（Stream Mode）

在钉钉开放平台创建企业内部应用并添加 Stream 模式机器人：

1. 开发者后台 → 创建**企业内部应用**，在「凭证与基础信息」拿到 ClientID（AppKey）和 ClientSecret（AppSecret）。
2. 「应用能力」→ 添加**机器人**，消息接收模式选择 **Stream 模式**，然后发布应用版本。
3. 按需给应用授权，并把机器人添加到群聊或从通讯录发起单聊。
4. 填入 `.env`（不要提交或发到聊天里）：

```bash
DINGTALK_ENABLED=true
DINGTALK_CLIENT_ID=your-app-key
DINGTALK_CLIENT_SECRET=your-app-secret
DINGTALK_ROBOT_CODE=your-robot-code   # 可选；当前被动回复用 sessionWebhook，不填也能收消息
```

5. 先单独验证凭证和 Stream 握手，不需要配置模型：

```bash
npm run dingtalk:check
```

看到 `[dingtalk] ✅ Stream connected` 就说明钉钉侧已接通。失败时会输出 HTTP 状态和 `authFailed` 等原因，可据此检查 AppKey/AppSecret、机器人能力、Stream 模式、应用是否已发布以及网络。

6. 启动 assistant：

```bash
npm run dev        # 钉钉模式（收到消息后转给 pi）
# 或
npm run daemon     # 同时提供钉钉和本地 CLI
```

还需要配置模型凭证（`.env` 的 `MODEL_API_KEY`，或本机 `pi` 登录过），否则能收到消息但无法生成回复。群聊里需要 @ 机器人。启用后 `npm run dev` 进入钉钉模式（不再启动 REPL），收到的文本消息会转给 pi 并回复，每个会话使用独立的持久化 session。

当前钉钉通道只处理文本；回复走被动 `sessionWebhook`，因此应用必须在消息有效期（通常约 1 小时）内回复。`DINGTALK_ROBOT_CODE` 暂时只用于日志，后续主动推送才会用到。

### 通过 DWS 导入历史聊天

机器人只能收到发给它的消息，标准 OpenAPI 也不提供任意历史聊天读取。要导入你账号可见的历史消息，可以把官方 `dws`（DingTalk Workspace CLI）放在另一台机器 B，A 上的 assistant 通过 Tailscale 内网 HTTPS 调用 B 的只读网关：

```text
A：assistant + Stream 机器人 + RAG
B：dws auth login + dws-gateway
```

B 上的部署、Tailscale、launchd 和 A 的配置详见 [`docs/DWS_GATEWAY.md`](docs/DWS_GATEWAY.md)。

A 上常用命令：

```bash
npm run dingtalk:dws-check
npm run dingtalk:history -- --group <openConversationId> --since 2026-01-01
npm run dingtalk:sync
```

配置：

```bash
DWS_ENABLED=true
DWS_GATEWAY_URL=https://<B机器名>.<tailnet>.ts.net
DWS_GATEWAY_TOKEN=...
DWS_HISTORY_GROUPS=cid1,cid2
```

当前只开放只读导入，不开放发送。历史消息使用 `openMessageId` 去重，DWS 返回不完整结果时不会把该时间范围标记为已同步。

RAG 会记录每轮对话并提供 `memory_search` 工具。默认使用 OpenAI 兼容的 embedding 接口，需配置 `RAG_EMBEDDING_API_KEY`（可选 `RAG_EMBEDDING_BASE_URL`）；本地调试可设 `RAG_EMBEDDING_PROVIDER=hash`。未配置凭证时 RAG 会自动跳过。

密钥库使用本地加密文件（AES-256-GCM，条目级 nonce + AAD），主密钥默认保存在 macOS Keychain，访问会写入审计日志（不记录值）。可用命令管理：

```bash
npm run vault -- set github_token --description "GitHub token"
npm run vault -- list
npm run vault -- get github_token
npm run vault -- rm github_token
```

Agent 可通过 `vault_get` / `vault_list` 工具访问密钥。CI 或非 macOS 环境可设置 `VAULT_MASTER_KEY`（base64 的 32 字节）或 `VAULT_PASSPHRASE`。

### 任务外派

Agent 可把耗时或独立任务交给后台 agent，使用内置工具：

- `delegate_task(description, target?)`：立即返回任务 id
- `check_task(taskId)`：查看状态和结果
- `cancel_task(taskId)`：取消排队或运行中的任务
- `list_tasks(status?)`：列出最近任务

任务会持久化到 `data/tasks.json`，重启后未完成的任务会标记为失败，避免静默丢失。默认后端 `local` 会在独立的 pi 子 session 中执行任务；也支持：

```bash
TASKS_BACKEND=pi-rpc           # 独立的 pi RPC 子进程，TASKS_PI_RPC_CLI 可覆盖 CLI 路径
TASKS_BACKEND=http-a2a         # 转发到 TASKS_HTTP_URL，POST 创建、GET 轮询、DELETE 取消
```

其他配置：`TASKS_CONCURRENCY`（默认 2）、`TASKS_TIMEOUT_MINUTES`（默认 30）、`TASKS_MAX_RECORDS`（默认 500）。钉钉会话通过 `delegate_task` 创建的任务完成后，会主动推送结果到原会话。

### 守护进程与本地 CLI

需要常驻时使用 daemon 模式。它会同时托管钉钉连接、任务队列、本地聊天 session，并在 `data/assistant.sock` 上提供本地控制接口：

```bash
npm run daemon                         # 前台运行 daemon
npm run assistant -- status            # 查看状态、任务统计
npm run assistant -- ping
npm run assistant -- chat "你好"        # 单次对话（流式输出）
npm run assistant -- chat              # 交互式对话
npm run assistant -- task list
npm run assistant -- task check <id>
npm run assistant -- shutdown
```

也可以在 `.env` 设置 `DAEMON_ENABLED=true`，让 `npm run dev` 直接进入 daemon 模式。socket 权限为 `0600`，只允许当前用户访问。

钉钉与本地 session 都有空闲回收和数量上限：`DINGTALK_SESSION_IDLE_MINUTES`（默认 120）、`DINGTALK_MAX_SESSIONS`（默认 100）；单会话限流 `DINGTALK_RATE_LIMIT_PER_MINUTE`（默认 20），单条消息上限 `DINGTALK_MAX_MESSAGE_CHARS`（默认 8000）。

### 构建与 launchd 自启

```bash
npm run build              # 输出 dist/assistant.js、client.js、vault.js、launchd.js
npm run start              # 运行构建产物（REPL）
npm run start:daemon       # 运行构建产物（daemon）
npm run daemon:install     # 写入 ~/Library/LaunchAgents 并启动
npm run daemon:status
npm run daemon:uninstall
```

launchd 会在崩溃后自动重启，日志写入 `data/logs/`。运行 `daemon:install` 前需要先执行 `npm run build`。

## 常用脚本

| 命令                         | 说明                        |
| ---------------------------- | --------------------------- |
| `npm run dev`                | 启动 assistant（REPL/钉钉） |
| `npm run daemon`             | 前台启动常驻 daemon         |
| `npm run assistant`          | 本地 CLI 控制 daemon        |
| `npm run dingtalk:check`     | 验证钉钉凭证与 Stream 连接  |
| `npm run dingtalk:dws-check` | 检查 B 上的 DWS 网关        |
| `npm run dingtalk:history`   | 手动导入指定群历史消息      |
| `npm run dingtalk:sync`      | 按配置增量同步历史消息      |
| `npm run gateway`            | 前台启动 DWS 网关（B 机）   |
| `npm run login`              | 登录订阅账号或保存模型凭证  |
| `npm run model:check`        | 查看当前可用的模型与账号    |
| `npm run daemon:install`     | 安装 launchd 自启项         |
| `npm run daemon:status`      | 查看 launchd 状态           |
| `npm run build`              | 构建生产产物到 `dist/`      |
| `npm run vault`              | 管理本地密钥库              |
| `npm run typecheck`          | TypeScript 类型检查         |
| `npm run lint`               | Biome 检查                  |
| `npm run lint:fix`           | Biome 自动修复              |
| `npm test`                   | Vitest 运行测试             |
| `npm run test:smoke`         | 构建产物的 daemon 冒烟测试  |

## 目录结构

```
apps/assistant/          # daemon + CLI 入口
apps/dws-gateway/        # B 机只读 DWS 网关
packages/
  config/                # zod 配置 schema 与加载
  core/                  # pi 会话装配、事件流、模型 provider
  rag/                   # 历史聊天知识库
  vault/                 # 加密密钥库
  channel-dingtalk/      # 钉钉 Stream 通道
  dingtalk-dws/          # DWS 网关客户端与历史消息导入
  tasks/                 # 任务外派（AgentDispatcher）
docs/PLAN.md             # 架构与里程碑
docs/DWS_GATEWAY.md      # DWS 历史导入部署说明
```

## 当前进度

- [x] M0 脚手架
- [x] M1 核心对话
- [x] M2 RAG
- [x] M3 Vault
- [x] M4 钉钉
- [x] M5 任务外派
- [x] M6 加固
- [x] DWS 历史聊天导入

## 安全

密钥只应存放于 Vault；`.env` 仅用于启动引导配置，且已被 `.gitignore` 忽略。日志通过 pino 递归脱敏（api key、token、secret、password、authorization 等），配置摘要不包含明文密钥。控制 socket 仅当前用户可读写，钉钉消息有去重、限流和长度限制。
