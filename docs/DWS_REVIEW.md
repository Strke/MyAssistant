# DWS 实时审阅（只读）

这条链路监听 B 机当前钉钉账号可见的群/单聊消息，把消息送到 A 机做 RAG 检索和模型判断，并把原始消息 + 判断结果写到 B 机的 JSONL 文件。

当前版本**只记录，不自动回复、不写黑板、不发送 DM**。

## 流程

```text
B 机
  dws event +listen-im
        │ NDJSON 消息事件
        ▼
  dws-watch
    - 按 messageId 去重
    - POST A /v1/dingtalk/review
        │ Tailscale HTTPS + Bearer token
        ▼
A 机
  assistant review server
    1. 消息写入 RAG
    2. bge-m3 检索相关历史
    3. deepseek-v4.1-flash 输出结构化判断
    4. 返回 decision
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
```

通过 Tailscale Serve 暴露给 tailnet：

```bash
tailscale serve --bg 8788
```

健康检查：

```bash
curl http://127.0.0.1:8788/health
```

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

- 只读：不自动回复、不写黑板、不发 DM
- 群聊只监听显式配置的 `DWS_WATCH_GROUPS`
- 单聊默认不监听；需要显式设置 `DWS_WATCH_DMS=all`
- 消息会进入 A 的 RAG，模型判断基于检索到的历史
- `related`/`alreadyDone` 是模型判断，不是绝对事实；不确定时应以 `alreadyDone=false` 处理
- 订阅进程断线会自动重启
