import { type ChildProcess, spawn } from "node:child_process";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface WatchConfig {
  dwsBin: string;
  groups: string[];
  watchAllDirect: boolean;
  ignoreSenders: Set<string>;
  reviewUrl: string;
  reviewToken: string;
  logPath: string;
  restartMs: number;
}

interface EventMessage {
  messageId: string;
  conversationId: string;
  chatType: string;
  sender?: string;
  senderOpenDingTalkId?: string;
  content: string;
  createdAt: number;
  eventId?: string;
  aiSend: boolean;
}

interface ReviewLogEntry {
  receivedAt: string;
  source: string;
  message: EventMessage;
  decision?: unknown;
  actions?: unknown;
  duplicate?: boolean;
  error?: string;
  durationMs: number;
}

function envCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadWatchConfig(env: NodeJS.ProcessEnv = process.env): WatchConfig {
  const reviewUrl = env.A_REVIEW_URL?.trim();
  const reviewToken = env.A_REVIEW_TOKEN?.trim();
  if (!reviewUrl) {
    throw new Error("A_REVIEW_URL is required.");
  }
  if (!reviewToken) {
    throw new Error("A_REVIEW_TOKEN is required.");
  }
  const groups = envCsv(env.DWS_WATCH_GROUPS);
  const watchAllDirect = env.DWS_WATCH_DMS?.trim() === "all";
  if (groups.length === 0 && !watchAllDirect) {
    throw new Error("DWS_WATCH_GROUPS is empty and DWS_WATCH_DMS is not 'all'.");
  }
  return {
    dwsBin: env.DWS_BIN?.trim() ?? "dws",
    groups,
    watchAllDirect,
    ignoreSenders: new Set(
      envCsv(env.DWS_WATCH_IGNORE_SENDERS).map((value) => value.toLowerCase()),
    ),
    reviewUrl: reviewUrl.replace(/\/$/, ""),
    reviewToken,
    logPath: env.DWS_WATCH_LOG?.trim() ?? resolve(homedir(), "dws-watch", "reviews.jsonl"),
    restartMs: Math.max(1_000, Number(env.DWS_WATCH_RESTART_MS ?? 5_000)),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseTime(value: unknown, fallback: number): number {
  const number = numberValue(value);
  if (number !== undefined) {
    return number < 1_000_000_000_000 ? number * 1_000 : number;
  }
  if (typeof value === "string" && value.trim()) {
    if (/^\d+$/.test(value.trim())) {
      const parsed = Number(value);
      return parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed;
    }
    const timestamp = Date.parse(value.replace(" ", "T"));
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return fallback;
}

export function extractEvent(raw: unknown, source: string): EventMessage | undefined {
  const root = record(raw);
  if (!root) {
    return undefined;
  }
  const payload = record(root.payload) ?? record(root.data) ?? record(root.body) ?? root;
  const find = (...values: unknown[]): unknown => values.find((value) => value !== undefined);

  const messageId = stringValue(
    find(
      root.message_id,
      root.messageId,
      root.openMessageId,
      payload.message_id,
      payload.messageId,
    ),
  );
  const conversationId = stringValue(
    find(
      root.conversation_id,
      root.conversationId,
      root.openConversationId,
      payload.conversation_id,
      payload.conversationId,
    ),
  );
  const rawContent = find(root.content, root.text, payload.content, payload.text);
  const content =
    typeof rawContent === "string"
      ? rawContent
      : (stringValue(record(rawContent)?.content) ?? stringValue(record(rawContent)?.text));
  if (!messageId || !conversationId || !content?.trim()) {
    return undefined;
  }

  const chatType = stringValue(
    find(
      root.chat_type,
      root.chatType,
      root.conversation_type,
      payload.chat_type,
      payload.chatType,
    ),
  );
  const aiSendValue = find(
    root.message_ai_send_flag,
    root.messageAiSendFlag,
    root.ai_send,
    root.aiTag,
    payload.message_ai_send_flag,
    payload.messageAiSendFlag,
    payload.aiTag,
  );
  const aiSend =
    aiSendValue === true || aiSendValue === 1 || aiSendValue === "true" || aiSendValue === "1";
  return {
    messageId,
    conversationId,
    chatType: chatType ?? (source.startsWith("group:") ? "group" : "direct"),
    sender: stringValue(find(root.sender, root.sender_nick, payload.sender, payload.sender_nick)),
    senderOpenDingTalkId: stringValue(
      find(
        root.sender_open_dingtalk_id,
        root.senderOpenDingTalkId,
        root.sender_id,
        payload.sender_open_dingtalk_id,
        payload.senderOpenDingTalkId,
      ),
    ),
    content: content.trim(),
    createdAt: parseTime(
      find(root.create_time, root.createTime, root.event_time, root.eventTime, payload.create_time),
      Date.now(),
    ),
    eventId: stringValue(find(root.event_id, root.eventId, payload.event_id)),
    aiSend,
  };
}

async function appendLog(path: string, entry: ReviewLogEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

async function postReview(
  config: WatchConfig,
  message: EventMessage,
  source: string,
): Promise<{
  duplicate: boolean;
  decision?: unknown;
  actions?: unknown;
}> {
  const response = await fetch(`${config.reviewUrl}/v1/dingtalk/review`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.reviewToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      source,
      eventId: message.eventId,
      messageId: message.messageId,
      conversationId: message.conversationId,
      chatType: message.chatType,
      sender: message.sender,
      senderOpenDingTalkId: message.senderOpenDingTalkId,
      content: message.content,
      createdAt: message.createdAt,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`A review server returned invalid JSON (HTTP ${response.status}).`);
  }
  const body = record(payload);
  if (!response.ok || body?.success === false) {
    throw new Error(
      stringValue(body?.error) ?? `A review server returned HTTP ${response.status}.`,
    );
  }
  return {
    duplicate: body?.duplicate === true,
    decision: body?.decision,
    actions: body?.actions,
  };
}

export class DwsWatcher {
  private readonly config: WatchConfig;
  private readonly children = new Set<ChildProcess>();
  private readonly seen = new Set<string>();
  private stopping = false;
  private restartTimers = new Set<NodeJS.Timeout>();

  constructor(config: WatchConfig) {
    this.config = config;
  }

  private isIgnoredSender(message: EventMessage): boolean {
    return Boolean(message.sender && this.config.ignoreSenders.has(message.sender.toLowerCase()));
  }

  start(): void {
    for (const groupId of this.config.groups) {
      this.spawnSource(`group:${groupId}`, [
        "event",
        "+listen-im",
        "--kind",
        "group",
        "--chat-id",
        groupId,
        "--events",
        "message",
        "--format",
        "ndjson",
      ]);
    }
    if (this.config.watchAllDirect) {
      this.spawnSource("direct:all", [
        "event",
        "+listen-im",
        "--kind",
        "all-direct",
        "--events",
        "message",
        "--format",
        "ndjson",
      ]);
    }
    process.stderr.write(
      `${JSON.stringify({
        event: "started",
        groups: this.config.groups.length,
        direct: this.config.watchAllDirect,
        logPath: this.config.logPath,
      })}\n`,
    );
  }

  stop(): void {
    this.stopping = true;
    for (const timer of this.restartTimers) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();
    for (const child of this.children) {
      child.kill("SIGTERM");
    }
  }

  private spawnSource(source: string, args: string[]): void {
    if (this.stopping) {
      return;
    }
    const child = spawn(this.config.dwsBin, args, {
      env: {
        ...process.env,
        NO_COLOR: "1",
        PATH: `${dirname(this.config.dwsBin)}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.add(child);
    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          void this.handleLine(source, line);
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      let newline = stderrBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stderrBuffer.slice(0, newline).trim();
        stderrBuffer = stderrBuffer.slice(newline + 1);
        if (line) {
          process.stderr.write(
            `${JSON.stringify({ event: "dws-status", source, line: line.slice(0, 300) })}\n`,
          );
        }
        newline = stderrBuffer.indexOf("\n");
      }
    });
    child.on("error", (error) => {
      process.stderr.write(
        `${JSON.stringify({ event: "watch-error", source, error: error.message })}\n`,
      );
    });
    child.on("exit", (code, signal) => {
      this.children.delete(child);
      if (this.stopping) {
        return;
      }
      process.stderr.write(`${JSON.stringify({ event: "watch-exit", source, code, signal })}\n`);
      const timer = setTimeout(() => {
        this.restartTimers.delete(timer);
        this.spawnSource(source, args);
      }, this.config.restartMs);
      this.restartTimers.add(timer);
    });
  }

  private async handleLine(source: string, line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stderr.write(`${JSON.stringify({ event: "watch-parse-error", source })}\n`);
      return;
    }
    const message = extractEvent(parsed, source);
    if (!message || message.aiSend || this.isIgnoredSender(message)) {
      return;
    }
    if (this.seen.has(message.messageId)) {
      return;
    }
    this.seen.add(message.messageId);
    if (this.seen.size > 20_000) {
      this.seen.clear();
      this.seen.add(message.messageId);
    }

    const started = Date.now();
    try {
      const result = await postReview(this.config, message, source);
      await appendLog(this.config.logPath, {
        receivedAt: new Date().toISOString(),
        source,
        message,
        decision: result.decision,
        actions: result.actions,
        duplicate: result.duplicate,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      await appendLog(this.config.logPath, {
        receivedAt: new Date().toISOString(),
        source,
        message,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      });
    }
  }
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.();
  } catch {
    // No .env file is fine.
  }
  const config = loadWatchConfig();
  const watcher = new DwsWatcher(config);
  const shutdown = () => {
    watcher.stop();
    setTimeout(() => process.exit(0), 1_000).unref?.();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  watcher.start();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "fatal",
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  });
}
