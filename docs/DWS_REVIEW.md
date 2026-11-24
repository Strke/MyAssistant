# DWS 实时审阅（只读）

这条链路监听 B 机当前钉钉账号可见的群/单聊消息，把消息送到 A 机做 RAG 检索和模型判断，并把原始消息 + 判断结果写到 B 机的 JSONL 文件。

在判断为相关时，会：

- 更新 A 机的黑板
- 将整块黑板推送到 B 的「黑板推送」群
- 在 MonkeyScan Review引擎 群和单聊中自动回复原消息

黑板只保留未完成事项；已完成事项只保留最新 5 项。

## 流程

```text
B 机
  dws event +listen-im
        │ NDJSON 消息事件
        ▼
  dws-watch
    - 按 messageId 去重
    - 跳过 AI 标记消息和配置的机器人发送者（默认邮箱助手等）
    - POST A /v1/dingtalk/review
        │ Tailscale HTTPS + Bearer token
        ▼
A 机
  assistant review server
    1. 消息写入 RAG
    2. bge-m3 检索相关历史
    3. deepseek-v4.1-flash 输出结构化判断
    4. 更新黑板、推送黑板群、自动回复
    5. 返回 decision + actions
        │
        ▼
B 机
  ~/dws-watch/reviews.jsonl
    原始消息 + 模型判断
```

## B 机：dws-watch

安装目录：

```text
~/dws-watch/
  dws-watch.js
  .env
  reviews.jsonl
  logs/
```

`.env`：

```bash
DWS_BIN=/Users/lin/.nvm/versions/node/v24.17.0/bin/dws
DWS_WATCH_GROUPS=cid6WlrFjAj3jSSMMczR+XEXQ==
DWS_WATCH_DMS=
A_REVIEW_URL=https://renzelinmac-mini.taild927d7.ts.net
A_REVIEW_TOKEN=与 A 的 REVIEW_TOKEN 一致
DWS_WATCH_LOG=/Users/lin/dws-watch/reviews.jsonl
DWS_WATCH_RESTART_MS=5000
DWS_WATCH_SELF_OPEN_DINGTALK_ID=当前用户自己的openDingTalkId
DWS_WATCH_IGNORE_SENDERS=邮箱助手,钉钉助手,钉钉小秘书
DWS_WATCH_IGNORE_OPEN_IDS=
```

`DWS_WATCH_GROUPS` 是群 `openConversationId`，多个用逗号分隔。`DWS_WATCH_DMS=all` 会监听全部单聊；默认留空，避免把所有私聊写入审阅库。

launchd：

```bash
launchctl print gui/$(id -u)/com.myassistant.dws-watch
tail -f ~/dws-watch/logs/watch.err.log
```

看到：

```text
[event] ready event_key=user_im_message_receive_group ...
source state: connected
```

说明订阅已就绪。

## A 机：review server

`.env`：

```bash
REVIEW_ENABLED=true
REVIEW_HOST=127.0.0.1
REVIEW_PORT=8788
REVIEW_TOKEN=随机长字符串
REVIEW_TOP_K=8
REVIEW_MAX_CONTENT_CHARS=8000
REVIEW_TIMEOUT_SECONDS=90
REVIEW_AUTO_REPLY=true
BLACKBOARD_ENABLED=true
BLACKBOARD_PATH=./data/blackboard.json
BLACKBOARD_GROUP_ID=cidx7ygN7Xd06+ARqXKam58gA==
BLACKBOARD_MAX_COMPLETED=5
```

通过 Tailscale Serve 暴露给 tailnet：

```bash
tailscale serve --bg 8788
```

健康检查：

```bash
curl http://127.0.0.1:8788/health
```

## 自动回复范围

B 的 gateway 只允许：

```bash
DWS_REPLY_GROUPS=cid6WlrFjAj3jSSMMczR+XEXQ==
DWS_REPLY_DMS=all
```

因此自动回复只会在 MonkeyScan Review引擎 群和单聊中发生。回复使用 DWS 当前登录用户身份，默认带 AI 角标。

跨组织单聊在 DWS 中可能缺少跨组织数据授权，回复会失败并记录在 `actions.reply.error`。如确需回复跨组织会话，需要在 B 上按提示执行：

```bash
dws chat data-auth cross-org --all --grant-type timed --ttl 24h --format json
```

## 黑板

- 未完成事项全部保留
- 已完成事项只保留最新 5 项
- 黑板文件：A 机 `data/blackboard.json`
- 黑板群：`cidx7ygN7Xd06+ARqXKam58gA==`（「黑板推送」）
- 只有黑板发生变化时才推送到群，避免刷屏

## 审阅文件

每条记录一行 JSON：

```json
{
  "receivedAt": "2026-11-25T02:30:00.000Z",
  "source": "group:cid...",
  "message": {
    "messageId": "...",
    "conversationId": "...",
    "chatType": "group",
    "sender": "张三",
    "content": "请确认漏洞修复是否完成",
    "createdAt": 179...
  },
  "decision": {
    "related": true,
    "alreadyDone": false,
    "confidence": 0.88,
    "reason": "...",
    "evidence": ["..."],
    "suggestedReply": "...",
    "blackboardItem": {
      "title": "确认漏洞修复进度",
      "details": "..."
    }
  },
  "actions": {
    "blackboard": { "action": "add", "changed": true, "taskId": "bb_..." },
    "pushed": true,
    "reply": { "sent": true, "text": "收到，我先记到黑板上了。" }
  },
  "duplicate": false,
  "durationMs": 6400
}
```

查看最新记录：

```bash
tail -f ~/dws-watch/reviews.jsonl | python3 -m json.tool --json-lines
```

或者：

```bash
tail -20 ~/dws-watch/reviews.jsonl | jq .
```

A 处理失败时也会写一条记录，带 `error` 字段，方便排查。

## 当前边界

- 群聊只监听显式配置的 `DWS_WATCH_GROUPS`
- 单聊由 `DWS_WATCH_DMS=all` 开启
- 消息会进入 A 的 RAG，模型判断基于检索到的历史
- `related`/`alreadyDone` 是模型判断，不是绝对事实；不确定时应以 `alreadyDone=false` 处理
- 默认跳过 `DWS_WATCH_IGNORE_SENDERS` 中的机器人发送者（邮箱助手、钉钉助手、钉钉小秘书）
- 你自己发出的消息仍然写入 RAG，但会标记为 `senderIsSelf`，不进入模型判断、不自动回复、不更新黑板，避免自我回复循环
- B gateway 也会拒绝回复发送者为当前用户的消息（`DWS_SELF_OPEN_DINGTALK_ID`）
- 订阅进程断线会自动重启

## 黑板推送群

B 的 gateway 可以配置一个专门的推送群：

```bash
DWS_SEND_GROUPS=cidx7ygN7Xd06+ARqXKam58gA==
```

并通过：

```text
POST /v1/chat/send
{"groupId":"cidx7ygN7Xd06+ARqXKam58gA==","text":"黑板内容"}
```

发送 Markdown 消息。当前使用 DWS 的**当前登录用户身份**发送；如果希望以机器人身份发送，需要 `robotCode` 和企业内机器人发送消息权限。发送接口只允许 `DWS_SEND_GROUPS` 中的群。
