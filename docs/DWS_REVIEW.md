# DWS 实时审阅（单聊 + 白名单回复）

这条链路监听 B 机当前钉钉账号可见的单聊消息，把消息送到 A 机做 RAG 检索和模型判断，并把原始消息 + 判断结果写到 B 机的 JSONL 文件。

当前只监听单聊，并且只对白名单中的单聊自动回复。收到消息后会：

- 更新 A 机的本地黑板
- 更新该会话的滚动摘要
- 写 B 机的审阅日志
- 仅对 A、B 两端白名单都允许的单聊回复原消息

不会把黑板推送到任何群，也不会回复群消息。

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
    2. 白名单单聊按会话聚合成消息块：静默 8 秒或最长 30 秒后处理
    3. 读取该会话持久化的滚动摘要；首次没有摘要时，用最近 15 条消息生成初始摘要
    4. bge-m3 检索长期历史（topK 8）
    5. deepseek-v4.1-flash 结合“滚动摘要 + 长期检索 + 黑板 + 上一条回复”判断
    6. 如果本块已被上一条回复覆盖，只更新摘要，不再回复
    7. 更新本地黑板；仅对白名单单聊自动回复，不推送黑板
    8. 把本块消息和实际回复（如有）合并进滚动摘要并持久化
    9. 返回 decision + actions + 更新后的 conversationSummary
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
DWS_WATCH_GROUPS=
DWS_WATCH_DMS=all
A_REVIEW_URL=https://renzelinmac-mini.taild927d7.ts.net
A_REVIEW_TOKEN=与 A 的 REVIEW_TOKEN 一致
DWS_WATCH_LOG=/Users/lin/dws-watch/reviews.jsonl
DWS_WATCH_RESTART_MS=5000
DWS_WATCH_SELF_OPEN_DINGTALK_ID=当前用户自己的openDingTalkId
DWS_WATCH_IGNORE_SENDERS=邮箱助手,钉钉助手,钉钉小秘书
DWS_WATCH_IGNORE_OPEN_IDS=
```

`DWS_WATCH_GROUPS` 是群 `openConversationId`，多个用逗号分隔。当前只监听单聊：`DWS_WATCH_GROUPS` 留空，`DWS_WATCH_DMS=all`。如需恢复某个群，把群 id 填回并重启 watcher。

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
REVIEW_RECENT_MESSAGES=15
REVIEW_SUMMARY_PATH=./data/conversation-summaries.json
REVIEW_MAX_CONTENT_CHARS=8000
REVIEW_TIMEOUT_SECONDS=90
REVIEW_AUTO_REPLY=true
REVIEW_AUTO_REPLY_DMS=白名单openDingTalkId或conversationId
REVIEW_REPLY_DEBOUNCE_SECONDS=8
REVIEW_REPLY_DEBOUNCE_MAX_SECONDS=30
REVIEW_BLOCK_CONTINUATION_SECONDS=180
REVIEW_BLOCK_PATH=./data/reply-blocks.json
BLACKBOARD_ENABLED=true
BLACKBOARD_PATH=./data/blackboard.json
BLACKBOARD_GROUP_ID=
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

## 发送与回复（白名单单聊）

A 端先按 `REVIEW_AUTO_REPLY_DMS` 过滤，B 端再用 `DWS_REPLY_DM_OPEN_DINGTALK_IDS` 做第二道校验。只有两边都允许的单聊才会回复。

当前配置：

```bash
# A
REVIEW_AUTO_REPLY=true
REVIEW_AUTO_REPLY_DMS=林雨涛的openDingTalkId
BLACKBOARD_GROUP_ID=

# B
DWS_SEND_GROUPS=
DWS_REPLY_GROUPS=
DWS_REPLY_DMS=
DWS_REPLY_DM_OPEN_DINGTALK_IDS=林雨涛的openDingTalkId
```

`REVIEW_AUTO_REPLY_DMS` 支持 `openDingTalkId`、`conversationId` 或 `all`。`all` 表示所有单聊。
`DWS_REPLY_DMS=all` 表示 B 端允许所有单聊；留空时只允许 `DWS_REPLY_DM_OPEN_DINGTALK_IDS` 中的发送者。

当前黑板推送仍然关闭。要恢复所有单聊自动回复：

```bash
# A
REVIEW_AUTO_REPLY_DMS=all
# B
DWS_REPLY_DMS=all
```

恢复黑板推送需要：

```bash
# A
BLACKBOARD_GROUP_ID=cidx7ygN7Xd06+ARqXKam58gA==
# B
DWS_SEND_GROUPS=cidx7ygN7Xd06+ARqXKam58gA==
```

跨组织单聊在 DWS 中可能缺少跨组织数据授权，恢复回复后可能失败并记录在 `actions.reply.error`。如确需回复跨组织会话，需要在 B 上按提示执行：

```bash
dws chat data-auth cross-org --all --grant-type timed --ttl 24h --format json
```

## 消息块与等待

白名单单聊不会收到一条就立刻回复，而是按“消息块”处理：

- 同一个会话里，对方连续发来的消息会合并成一个块。
- 每条新消息都会重置静默计时；静默 `REVIEW_REPLY_DEBOUNCE_SECONDS`（默认 8 秒）后开始处理。
- 从第一条消息算起最多等待 `REVIEW_REPLY_DEBOUNCE_MAX_SECONDS`（默认 30 秒），避免一直等。
- 处理时把整块消息一起判断和回复，只回复一次。
- 回复后 `REVIEW_BLOCK_CONTINUATION_SECONDS`（默认 180 秒）内，如果对方继续发消息，会把上一条回复和新消息一起交给模型判断：
  - 如果上一条回复已经覆盖这些消息，标记 `actions.skipped="covered"`，不再回复。
  - 如果对方补充了新请求、纠正了理解，或需要新信息，则作为新块继续回复。
- 上一条回复保存在 `REVIEW_BLOCK_PATH`（默认 `data/reply-blocks.json`），重启后仍能判断续聊。

日志里会出现：

- `batchSize`：这一块包含几条消息
- `previousReplyUsed`：是否带上了上一条回复
- `coveredByPreviousReply`：是否被上一条回复覆盖
- `batched: true`：该条消息属于同一块的非最后一条，B 不重复记录判断结果

## 黑板

- 未完成事项全部保留
- 已完成事项只保留最新 5 项
- 黑板文件：A 机 `data/blackboard.json`
- 当前 `BLACKBOARD_GROUP_ID` 留空，黑板只在本机更新，不推送
- 以后恢复推送时使用：`cidx7ygN7Xd06+ARqXKam58gA==`（「黑板推送」）
- 只有黑板发生变化时才推送，避免刷屏

## 滚动摘要

每个 `conversationId` 在 A 机持久化一份滚动摘要，默认文件：

```text
data/conversation-summaries.json
```

处理顺序：

1. 新消息写入 RAG。
2. 读取该会话已有摘要。首次没有摘要时，取同一会话最近 15 条消息（不含当前消息块）生成初始摘要。
3. 用整块消息做长期 RAG 检索，结合滚动摘要、黑板和上一条回复进行判断。
4. 如果本块已被上一条回复覆盖，只更新摘要，不再回复或改黑板。
5. 否则更新本地黑板；仅对白名单单聊回复，不推送黑板。
6. 把整块消息（以及实际发出的回复，如果有）交给模型，合并进旧摘要，覆盖保存。
7. 自己发送的消息仍写入 RAG，但不会触发判断、回复、黑板动作或摘要更新；非白名单会话没有自动回复，因此只合并对方消息。

这样摘要会随对话持续滚动，不需要每次把最近 15 条重新压缩；`REVIEW_RECENT_MESSAGES` 只用于首次初始化摘要。

每条记录返回的是本轮更新后的摘要，写入 B 的 `reviews.jsonl` 的 `conversationSummary` 字段。

## 审阅文件

每条记录一行 JSON：

```json
{
  "receivedAt": "2026-11-25T02:30:00.000Z",
  "source": "direct:all",
  "message": {
    "messageId": "...",
    "conversationId": "...",
    "chatType": "direct",
    "sender": "张三",
    "content": "请确认漏洞修复是否完成",
    "createdAt": 179...
  },
  "decision": {
    "related": true,
    "alreadyDone": false,
    "coveredByPreviousReply": false,
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
    "reply": { "sent": true, "text": "收到，我先记到黑板上了。" }
  },
  "conversationSummary": "本轮更新后的滚动摘要...",
  "batchSize": 2,
  "duplicate": false,
  "durationMs": 6400
}
```

同一块的非最后一条会记录 `"batched": true`；如果被上一条回复覆盖，会记录 `"actions": {"skipped": "covered"}`，不会发送新回复。

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

- 当前仅对白名单单聊自动回复；其他单聊和所有群不回复；黑板只本地更新、不推送；消息仍进入 RAG、更新滚动摘要并写审阅日志
- 白名单单聊会等待消息块：静默 8 秒或最长 30 秒后处理，一块只回复一次
- 回复后 180 秒内的续聊会先判断是否已被上一条回复覆盖；覆盖则不再回复
- 上一条回复持久化在 `data/reply-blocks.json`
- 当前只监听单聊；群聊默认关闭，需要在 `DWS_WATCH_GROUPS` 显式加回并重启 watcher
- 单聊由 `DWS_WATCH_DMS=all` 开启
- 消息会进入 A 的 RAG，模型判断基于检索到的历史
- `related`/`alreadyDone` 是模型判断，不是绝对事实；不确定时应以 `alreadyDone=false` 处理
- 默认跳过 `DWS_WATCH_IGNORE_SENDERS` 中的机器人发送者（邮箱助手、钉钉助手、钉钉小秘书）
- 你自己发出的消息仍然写入 RAG，但会标记为 `senderIsSelf`，不进入模型判断、不自动回复、不更新黑板，避免自我回复循环
- B gateway 也会拒绝回复发送者为当前用户的消息（`DWS_SELF_OPEN_DINGTALK_ID`）
- 订阅进程断线会自动重启

## 黑板推送群

当前未启用。以后需要恢复时，B 的 gateway 配置：

```bash
DWS_SEND_GROUPS=cidx7ygN7Xd06+ARqXKam58gA==
```

并通过：

```text
POST /v1/chat/send
{"groupId":"cidx7ygN7Xd06+ARqXKam58gA==","text":"黑板内容"}
```

发送 Markdown 消息。当前使用 DWS 的**当前登录用户身份**发送；如果希望以机器人身份发送，需要 `robotCode` 和企业内机器人发送消息权限。发送接口只允许 `DWS_SEND_GROUPS` 中的群。
