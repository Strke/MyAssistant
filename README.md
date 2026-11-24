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

`npm run dev` 目前会加载配置并打印脱敏后的运行摘要（M0 脚手架）。

## 常用脚本

| 命令                | 说明                |
| ------------------- | ------------------- |
| `npm run dev`       | 启动 assistant      |
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
- [ ] M1 核心对话
- [ ] M2 RAG
- [ ] M3 Vault
- [ ] M4 钉钉
- [ ] M5 任务外派
- [ ] M6 加固

## 安全

密钥只应存放于 Vault；`.env` 仅用于启动引导配置，且已被 `.gitignore` 忽略。日志与配置摘要均不得包含明文密钥。
