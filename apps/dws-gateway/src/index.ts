import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

const VERSION = "1.0.0";
const MAX_BODY_BYTES = 64 * 1024;
const AUTH_CACHE_MS = 15_000;

export interface GatewayConfig {
  host: string;
  port: number;
  token: string;
  dwsBin: string;
  allowedGroups: Set<string>;
  sendGroups: Set<string>;
  requestTimeoutMs: number;
  maxItems: number;
  maxConcurrent: number;
  logRequests: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export type DwsRunner = (args: string[], timeoutMs: number) => Promise<CommandResult>;

export interface GatewayOptions {
  config: GatewayConfig;
  runner?: DwsRunner;
  logger?: (event: Record<string, unknown>) => void;
}

interface AuthStatus {
  authenticated: boolean;
  message?: string;
  version?: string;
}

interface NormalizedPage {
  messages: unknown[];
  complete: boolean;
  hasMore: boolean;
  nextPage?: unknown;
  stopReason?: string;
  truncated?: boolean;
  truncatedByPageLimit?: boolean;
  truncatedByResultLimit?: boolean;
  partial?: boolean;
  pagesFetched?: number;
  count: number;
  skipped: number;
  failedCount: number;
  failures: unknown[];
  queryRange?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function errorMessageFrom(value: unknown): string | undefined {
  const record = asRecord(value);
  const error = asRecord(record?.error);
  return stringValue(error?.message) ?? stringValue(record?.message);
}

function commandError(result: CommandResult, parsed: unknown): Error {
  const stderrParsed = parseJson(result.stderr);
  const message =
    errorMessageFrom(parsed) ??
    errorMessageFrom(stderrParsed) ??
    (result.stderr.trim().slice(0, 500) || `dws exited with code ${result.code}.`);
  return new Error(result.timedOut ? `dws timed out: ${message}` : message);
}

export function createDwsRunner(bin: string): DwsRunner {
  return (args, timeoutMs) =>
    new Promise((resolve) => {
      execFile(
        bin,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, NO_COLOR: "1" },
        },
        (error, stdout, stderr) => {
          const candidate = error as (Error & { code?: number | string; killed?: boolean }) | null;
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            code: typeof candidate?.code === "number" ? candidate.code : candidate ? 1 : 0,
            timedOut: Boolean(candidate?.killed),
          });
        },
      );
    });
}

function normalizeMessage(
  raw: unknown,
  fallbackConversationId: string,
): Record<string, unknown> | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  const messageId =
    stringValue(record.messageId) ?? stringValue(record.openMessageId) ?? stringValue(record.id);
  const conversationId =
    stringValue(record.conversationId) ??
    stringValue(record.openConversationId) ??
    fallbackConversationId;
  const textValue = record.text;
  const text =
    typeof textValue === "string"
      ? textValue
      : (stringValue(asRecord(textValue)?.content) ?? stringValue(asRecord(textValue)?.text));
  if (!messageId || !conversationId || !text?.trim()) {
    return undefined;
  }

  return {
    messageId,
    conversationId,
    threadId: stringValue(record.threadId),
    sender:
      stringValue(record.sender) ??
      stringValue(record.senderNick) ??
      stringValue(record.senderName),
    senderId: stringValue(record.senderId) ?? stringValue(record.senderOpenDingTalkId),
    senderType: stringValue(record.senderType),
    messageType: stringValue(record.messageType),
    text: text.trim(),
    createTime:
      stringValue(record.createTime) ??
      stringValue(record.createdAt) ??
      (numberValue(record.createTime) !== undefined ? String(record.createTime) : undefined),
    updateTime: stringValue(record.updateTime),
    quotedMessage: record.quotedMessage,
    resourceRefs: record.resourceRefs,
  };
}

export function normalizeMessagePage(raw: unknown, fallbackConversationId: string): NormalizedPage {
  const record = asRecord(raw) ?? {};
  const data = asRecord(record.data);
  const rawMessages =
    (Array.isArray(record.messages) && record.messages) ||
    (Array.isArray(data?.messages) && data.messages) ||
    (Array.isArray(record.result) && record.result) ||
    [];
  const messages: unknown[] = [];
  let skipped = 0;
  for (const item of rawMessages) {
    const normalized = normalizeMessage(item, fallbackConversationId);
    if (normalized) {
      messages.push(normalized);
    } else {
      skipped += 1;
    }
  }

  return {
    messages,
    complete: booleanValue(record.complete) ?? booleanValue(data?.complete) ?? false,
    hasMore: booleanValue(record.hasMore) ?? booleanValue(data?.hasMore) ?? false,
    nextPage: record.nextPage ?? data?.nextPage,
    stopReason: stringValue(record.stopReason) ?? stringValue(data?.stopReason),
    truncated: booleanValue(record.truncated) ?? booleanValue(data?.truncated),
    truncatedByPageLimit:
      booleanValue(record.truncatedByPageLimit) ?? booleanValue(data?.truncatedByPageLimit),
    truncatedByResultLimit:
      booleanValue(record.truncatedByResultLimit) ?? booleanValue(data?.truncatedByResultLimit),
    partial: booleanValue(record.partial) ?? booleanValue(data?.partial),
    pagesFetched: numberValue(record.pagesFetched) ?? numberValue(data?.pagesFetched),
    count: messages.length,
    skipped,
    failedCount: numberValue(record.failedCount) ?? numberValue(data?.failedCount) ?? 0,
    failures: Array.isArray(record.failures)
      ? record.failures
      : Array.isArray(data?.failures)
        ? data.failures
        : [],
    queryRange: record.queryRange ?? data?.queryRange,
  };
}

function normalizeChats(raw: unknown): Array<Record<string, unknown>> {
  const record = asRecord(raw) ?? {};
  const data = asRecord(record.data);
  const chats =
    (Array.isArray(record.chats) && record.chats) ||
    (Array.isArray(data?.chats) && data.chats) ||
    [];
  const result: Array<Record<string, unknown>> = [];
  for (const item of chats) {
    const chat = asRecord(item);
    if (!chat) {
      continue;
    }
    const id =
      stringValue(chat.openConversationId) ??
      stringValue(chat.conversationId) ??
      stringValue(chat.id);
    if (!id) {
      continue;
    }
    result.push({
      openConversationId: id,
      name: stringValue(chat.name) ?? stringValue(chat.title),
      type: stringValue(chat.type),
      nameKnown: booleanValue(chat.nameKnown),
    });
  }
  return result;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function validateTime(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    throw new Error(`${name} must be YYYY-MM-DD or YYYY-MM-DD HH:mm:ss.`);
  }
  return value;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const token = env.DWS_GATEWAY_TOKEN?.trim() ?? "";
  if (!token && env.DWS_ALLOW_UNAUTHENTICATED !== "1") {
    throw new Error(
      "DWS_GATEWAY_TOKEN is required. Set DWS_ALLOW_UNAUTHENTICATED=1 only for local development.",
    );
  }
  const allowedGroups = new Set(
    (env.DWS_ALLOWED_GROUPS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const sendGroups = new Set(
    (env.DWS_SEND_GROUPS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const port = Number(env.DWS_GATEWAY_PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("DWS_GATEWAY_PORT must be a valid port.");
  }
  return {
    host: env.DWS_GATEWAY_HOST?.trim() ?? "127.0.0.1",
    port,
    token,
    dwsBin: env.DWS_BIN?.trim() ?? "dws",
    allowedGroups,
    sendGroups,
    requestTimeoutMs: Math.max(5, Number(env.DWS_REQUEST_TIMEOUT_SECONDS ?? 120)) * 1_000,
    maxItems: Math.max(1, Number(env.DWS_MAX_ITEMS ?? 5_000)),
    maxConcurrent: Math.max(1, Number(env.DWS_MAX_CONCURRENT ?? 2)),
    logRequests: env.DWS_LOG_REQUESTS !== "0",
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export function createGatewayServer(options: GatewayOptions): Server {
  const { config } = options;
  const runner = options.runner ?? createDwsRunner(config.dwsBin);
  const log = options.logger ?? ((event) => process.stderr.write(`${JSON.stringify(event)}\n`));
  const startedAt = Date.now();
  let active = 0;
  let authCache: { at: number; value: AuthStatus } | undefined;

  const getAuthStatus = async (force = false): Promise<AuthStatus> => {
    if (!force && authCache && Date.now() - authCache.at < AUTH_CACHE_MS) {
      return authCache.value;
    }
    const result = await runner(["auth", "status", "--format", "json"], 30_000);
    const parsed = parseJson(result.stdout);
    const record = asRecord(parsed);
    const value: AuthStatus = {
      authenticated: record?.authenticated === true,
      message: stringValue(record?.message),
      version: stringValue(asRecord(record?.version_check)?.current),
    };
    authCache = { at: Date.now(), value };
    return value;
  };

  const handleMessages = async (body: unknown): Promise<unknown> => {
    const record = asRecord(body);
    if (!record) {
      throw new Error("Request body must be an object.");
    }
    const targets = [
      record.groupId ? "group" : undefined,
      record.userId ? "user" : undefined,
      record.openDingTalkId ? "openDingTalkId" : undefined,
    ].filter(Boolean);
    if (targets.length !== 1) {
      throw new Error("Exactly one of groupId, userId or openDingTalkId is required.");
    }

    const groupId = stringValue(record.groupId);
    const userId = stringValue(record.userId);
    const openDingTalkId = stringValue(record.openDingTalkId);
    if (groupId && config.allowedGroups.size > 0 && !config.allowedGroups.has(groupId)) {
      const error = new Error("This group is not in DWS_ALLOWED_GROUPS.");
      (error as Error & { status?: number }).status = 403;
      throw error;
    }
    if (groupId && groupId.length > 500) {
      throw new Error("groupId is too long.");
    }

    const start = validateTime(record.start, "start");
    const end = validateTime(record.end, "end");
    const order = record.order === "asc" || record.order === "desc" ? record.order : undefined;
    const pageAll = record.pageAll === true;
    const pageLimit = Math.min(500, positiveInteger(record.pageLimit, 100));
    const maxItems = Math.min(config.maxItems, positiveInteger(record.maxItems, config.maxItems));
    const limit =
      record.limit === undefined ? undefined : Math.max(1, positiveInteger(record.limit, 1));

    const args = ["chat", "+chat-messages"];
    if (groupId) {
      args.push("--group", groupId);
    } else if (userId) {
      args.push("--user", userId);
    } else if (openDingTalkId) {
      args.push("--open-dingtalk-id", openDingTalkId);
    }
    if (start) {
      args.push("--start", start);
    }
    if (end) {
      args.push("--end", end);
    }
    if (order) {
      args.push("--order", order);
    }
    if (pageAll) {
      args.push("--page-all", "--page-limit", String(pageLimit), "--max-items", String(maxItems));
    } else if (limit) {
      args.push("--limit", String(limit));
    }
    args.push("--no-reactions", "--format", "json");

    const result = await runner(args, config.requestTimeoutMs);
    const parsed = parseJson(result.stdout);
    if (parsed === undefined) {
      throw commandError(result, undefined);
    }
    const page = normalizeMessagePage(parsed, groupId ?? userId ?? openDingTalkId ?? "");
    const parsedRecord = asRecord(parsed);
    const structuredResult =
      typeof parsedRecord?.contractVersion === "string" ||
      typeof parsedRecord?.complete === "boolean" ||
      Array.isArray(parsedRecord?.failures);
    if (page.messages.length === 0 && result.code !== 0 && !structuredResult) {
      throw commandError(result, parsed);
    }
    return page;
  };

  const handleSearch = async (body: unknown): Promise<unknown> => {
    const record = asRecord(body);
    const query = stringValue(record?.query);
    if (!query) {
      throw new Error("query is required.");
    }
    if (query.length > 200) {
      throw new Error("query is too long (max 200 characters).");
    }
    const result = await runner(
      ["chat", "+chat-search", "--query", query, "--format", "json"],
      config.requestTimeoutMs,
    );
    const parsed = parseJson(result.stdout);
    if (parsed === undefined) {
      throw commandError(result, undefined);
    }
    const chats = normalizeChats(parsed);
    if (chats.length === 0 && result.code !== 0) {
      throw commandError(result, parsed);
    }
    return { chats, count: chats.length };
  };

  const handleSend = async (body: unknown): Promise<unknown> => {
    const record = asRecord(body);
    const groupId = stringValue(record?.groupId);
    const text = stringValue(record?.text);
    if (!groupId || !text) {
      throw new Error("groupId and text are required.");
    }
    if (config.sendGroups.size === 0) {
      const error = new Error("DWS_SEND_GROUPS is empty; sending is disabled.");
      (error as Error & { status?: number }).status = 403;
      throw error;
    }
    if (!config.sendGroups.has(groupId)) {
      const error = new Error("This group is not in DWS_SEND_GROUPS.");
      (error as Error & { status?: number }).status = 403;
      throw error;
    }
    if (text.length > 10_000) {
      throw new Error("text is too long (max 10000 characters).");
    }

    const result = await runner(
      [
        "chat",
        "+send-to-group",
        "--group",
        groupId,
        "--content",
        text,
        "--yes",
        "--format",
        "json",
      ],
      config.requestTimeoutMs,
    );
    const parsed = parseJson(result.stdout);
    if (parsed === undefined) {
      throw commandError(result, undefined);
    }
    const parsedRecord = asRecord(parsed);
    if (parsedRecord?.error) {
      throw commandError(result, parsed);
    }
    return { sent: true, groupId };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    let status = 200;
    try {
      if (path === "/health") {
        let auth: AuthStatus | undefined;
        let authError: string | undefined;
        try {
          auth = await getAuthStatus();
        } catch (error) {
          authError = error instanceof Error ? error.message : String(error);
        }
        send(res, 200, {
          success: true,
          data: {
            service: "dws-gateway",
            version: VERSION,
            uptimeMs: Date.now() - startedAt,
            authenticated: auth?.authenticated,
            authMessage: auth?.message ?? authError,
            allowedGroups: config.allowedGroups.size,
          },
        });
        return;
      }

      if (config.token) {
        const authorization = req.headers.authorization ?? "";
        const expected = `Bearer ${config.token}`;
        if (!safeEqual(authorization, expected)) {
          status = 401;
          send(res, 401, { success: false, error: "Unauthorized." });
          return;
        }
      }

      if (req.method === "GET" && path === "/v1/auth/status") {
        send(res, 200, { success: true, data: await getAuthStatus(true) });
        return;
      }

      if (req.method === "POST" && path === "/v1/chat/search") {
        const body = await readBody(req);
        send(res, 200, { success: true, data: await handleSearch(body) });
        return;
      }

      if (req.method === "POST" && path === "/v1/chat/messages") {
        if (active >= config.maxConcurrent) {
          status = 429;
          send(res, 429, { success: false, error: "Too many concurrent DWS requests." });
          return;
        }
        active += 1;
        try {
          const body = await readBody(req);
          send(res, 200, { success: true, data: await handleMessages(body) });
        } finally {
          active -= 1;
        }
        return;
      }

      if (req.method === "POST" && path === "/v1/chat/send") {
        if (active >= config.maxConcurrent) {
          status = 429;
          send(res, 429, { success: false, error: "Too many concurrent DWS requests." });
          return;
        }
        active += 1;
        try {
          const body = await readBody(req);
          send(res, 200, { success: true, data: await handleSend(body) });
        } finally {
          active -= 1;
        }
        return;
      }

      status = 404;
      send(res, 404, { success: false, error: "Not found." });
    } catch (error) {
      const customStatus = (error as Error & { status?: number }).status;
      status =
        customStatus ?? (error instanceof Error && error.message.includes("body") ? 400 : 502);
      const message = error instanceof Error ? error.message : String(error);
      send(res, status, { success: false, error: message });
    } finally {
      if (config.logRequests) {
        log({
          event: "request",
          method: req.method,
          path,
          status,
          durationMs: Date.now() - started,
        });
      }
    }
  };

  return createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent) {
        send(res, 500, { success: false, error: "Internal gateway error." });
      }
      log({ event: "error", error: error instanceof Error ? error.message : String(error) });
    });
  });
}

export async function startGatewayServer(options: GatewayOptions): Promise<{
  server: Server;
  port: number;
  close: () => Promise<void>;
}> {
  const server = createGatewayServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.config.port, options.config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.config.port;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.();
  } catch {
    // No .env file is fine.
  }
  const config = loadGatewayConfig();
  const instance = await startGatewayServer({ config });
  process.stderr.write(
    `${JSON.stringify({
      event: "started",
      host: config.host,
      port: instance.port,
      allowedGroups: config.allowedGroups.size,
      dwsBin: config.dwsBin,
    })}\n`,
  );
  const shutdown = () => {
    void instance.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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
