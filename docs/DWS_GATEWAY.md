# DWS 历史聊天导入

这个方案把 `dws` 放在 B 机，A 机上的 assistant 通过 Tailscale 内网 HTTPS 调用 B 上的只读网关。DWS 登录凭证只保存在 B，A 不接触 token。

## 架构

```text
钉钉云端
  ├─ Stream WebSocket → A: assistant 实时收发
  └─ 用户身份 OpenAPI → B: dws

A: assistant / RAG
  └─ HTTPS + Bearer token → B: dws-gateway:8787
```

当前只实现只读历史导入，不开放发送接口。

## B 机准备

1. 安装并登录 DWS：

```bash
npm install -g dingtalk-workspace-cli
dws auth login
dws auth status --format json
```

需要管理员在钉钉开发者后台开启 CLI 访问：`更多 → 基本信息 → CLI 设置`。

2. 构建并复制网关（在 A 的项目目录执行）：

```bash
npm run build
scp dist/dws-gateway.js b:~/dws-gateway/dws-gateway.js
```

B 机需要 Node.js 22。

3. 在 B 上创建 `~/dws-gateway/.env`：

```bash
DWS_GATEWAY_HOST=127.0.0.1
DWS_GATEWAY_PORT=8787
DWS_GATEWAY_TOKEN=请换成一个随机长字符串
# 在 B 上执行 which dws 后填入绝对路径，launchd 的 PATH 很精简。
DWS_BIN=/opt/homebrew/bin/dws
DWS_ALLOWED_GROUPS=cid1,cid2
DWS_MAX_ITEMS=5000
DWS_MAX_CONCURRENT=2
DWS_REQUEST_TIMEOUT_SECONDS=120
DWS_LOG_REQUESTS=1
```

`DWS_ALLOWED_GROUPS` 为空表示允许所有群；生产建议显式列出。

4. 启动网关：

```bash
cd ~/dws-gateway
node dws-gateway.js
```

5. 用 launchd 常驻（B 机）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.myassistant.dws-gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOU/dws-gateway/dws-gateway.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/dws-gateway</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/Users/YOU/dws-gateway/gateway.out.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/dws-gateway/gateway.err.log</string>
</dict>
</plist>
```

保存到 `~/Library/LaunchAgents/com.myassistant.dws-gateway.plist`，然后：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.myassistant.dws-gateway.plist
```

`ProgramArguments` 里的 Node 路径请用 B 上 `which node` 的结果替换；`DWS_BIN` 同理。

## Tailscale

A、B 都登录同一个 tailnet。B 上：

```bash
tailscale up
tailscale serve --bg 8787
tailscale status
```

`tailscale serve` 只暴露给 tailnet，不要使用 `tailscale funnel`。

A 上验证：

```bash
curl https://<B机器名>.<tailnet>.ts.net/health
```

## A 机配置

```bash
DWS_ENABLED=true
DWS_GATEWAY_URL=https://<B机器名>.<tailnet>.ts.net
DWS_GATEWAY_TOKEN=与 B 的 DWS_GATEWAY_TOKEN 一致
DWS_HISTORY_GROUPS=cid1,cid2
DWS_HISTORY_INTERVAL_MINUTES=60
DWS_HISTORY_OVERLAP_MINUTES=10
DWS_HISTORY_BACKFILL_DAYS=30
DWS_PAGE_SIZE=100
DWS_MAX_ITEMS_PER_SYNC=5000
```

验证：

```bash
npm run dingtalk:dws-check
```

## 导入历史

先搜群拿到 `openConversationId`（在 B 上执行，或由网关搜索）：

```bash
dws chat +chat-search --query "项目群" --format json
```

在 A 上手动导入：

```bash
npm run dingtalk:history -- \
  --group <openConversationId> \
  --since 2026-01-01 \
  --until 2026-11-25
```

增量同步：

```bash
npm run dingtalk:sync
```

同步状态保存在 `data/dingtalk-sync.json`，使用 `openMessageId` 去重。DWS 返回 `complete=false` 时不会把该范围标记为完整，会保留失败信息。

建议用 cron 或 launchd 每小时执行一次：

```cron
0 * * * * cd /Users/you/MyAssistant && /usr/local/bin/npm run dingtalk:sync >> data/logs/dingtalk-sync.log 2>&1
```

## 安全

- DWS token 只在 B，A 只保存 gateway token
- gateway 绑定 `127.0.0.1`，通过 Tailscale Serve 暴露给 tailnet
- 所有 `/v1/*` 都需要 Bearer token
- 群白名单、时间范围、最大条数限制
- 日志不记录消息正文和 token
- 默认只读；发送接口未开放
- 确认企业政策允许把聊天内容从 B 传输到 A，并遵守留存期限

## 接口

```text
GET  /health
GET  /v1/auth/status
POST /v1/chat/search    {"query":"群名"}
POST /v1/chat/messages  {"groupId":"cid...","start":"2026-01-01 00:00:00","pageAll":true}
```

`/v1/chat/messages` 支持 `groupId`、`userId`、`openDingTalkId` 三选一，支持 `start`、`end`、`order`、`pageAll`、`pageLimit`、`maxItems`。
