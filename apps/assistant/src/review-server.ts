import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AppConfig } from "@myassistant/config";
import {
  createReviewEngine,
  type Logger,
  type ReviewDecision,
  type ReviewEngine,
} from "@myassistant/core";
import type { ChatMessageRecord, MemoryHit, RagStore } from "@myassistant/rag";

const MAX_BODY_BYTES = 128 * 1024;

export interface ReviewServerOptions {
  config: AppConfig;
  store: RagStore;
  logger?: Logger;
}

export interface ReviewServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly port: number;
}

interface ReviewEvent {
  eventId?: string;
  messageId: string;
  conversationId: string;
  chatType?: string;
  sender?: string;
  senderOpenDingTalkId?: string;
  content: string;
  createdAt?: number;
  source?: string;
}

interface ReviewResponse {
  duplicate: boolean;
  decision?: ReviewDecision;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeEvent(value: unknown): ReviewEvent {
  const record = asRecord(value);
  if (!record) {
    throw new Error("Request body must be a JSON object.");
  }
  const messageId = stringValue(record.messageId);
  const conversationId = stringValue(record.conversationId);
  const content = stringValue(record.content);
  if (!messageId || !conversationId || !content) {
    throw new Error("messageId, conversationId and content are required.");
  }
  const createdAt =
    typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
      ? record.createdAt
      : undefined;
  return {
    eventId: stringValue(record.eventId),
    messageId,
    conversationId,
    chatType: stringValue(record.chatType),
    sender: stringValue(record.sender),
    senderOpenDingTalkId: stringValue(record.senderOpenDingTalkId),
    content,
    createdAt,
    source: stringValue(record.source),
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
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

function tokenMatches(header: string | undefined, token: string): boolean {
  return header === `Bearer ${token}`;
}

export async function createReviewServer(options: ReviewServerOptions): Promise<ReviewServer> {
  const { config, store, logger } = options;
  if (!config.review.token) {
    throw new Error("REVIEW_TOKEN is required when the review server is enabled.");
  }
  const engine: ReviewEngine = await createReviewEngine(config, { logger });

  const handleEvent = async (event: ReviewEvent): Promise<ReviewResponse> => {
    if (store.hasMessage?.("dingtalk", event.messageId)) {
      return { duplicate: true };
    }

    const createdAt = event.createdAt ?? Date.now();
    const record: ChatMessageRecord = {
      id: `dws:${event.messageId}`,
      conversationId: `dingtalk:${event.conversationId}`,
      role: "user",
      sender: event.sender ?? event.senderOpenDingTalkId,
      channel: "dingtalk",
      externalId: event.messageId,
      content: event.content,
      createdAt,
    };
    await store.addMessage(record);

    let hits: MemoryHit[] = [];
    try {
      hits = await store.search(event.content, { topK: config.review.topK });
    } catch (error) {
      logger?.warn({ err: error }, "review retrieval failed; continuing without memory");
    }
    const relatedHits = hits.filter((hit) => hit.messageId !== record.id);

    const decision = await engine.judge({
      message: {
        content: event.content,
        sender: event.sender,
        conversationId: event.conversationId,
        chatType: event.chatType,
        createdAt,
      },
      hits: relatedHits.map((hit) => ({
        content: hit.content,
        createdAt: hit.createdAt,
        conversationId: hit.conversationId,
      })),
    });

    logger?.info(
      {
        eventId: event.eventId,
        messageId: event.messageId,
        chatType: event.chatType,
        related: decision.related,
        alreadyDone: decision.alreadyDone,
        confidence: decision.confidence,
      },
      "review decision",
    );
    return { duplicate: false, decision };
  };

  let server: Server | undefined;
  let port = config.review.port;
  let started = false;

  return {
    get port() {
      return port;
    },
    async start() {
      if (started) {
        return;
      }
      server = createServer((req, res) => {
        const path = (req.url ?? "/").split("?")[0] ?? "/";
        void (async () => {
          try {
            if (path === "/health") {
              send(res, 200, {
                success: true,
                data: { service: "assistant-review", status: "ok" },
              });
              return;
            }
            if (path !== "/v1/dingtalk/review" || req.method !== "POST") {
              send(res, 404, { success: false, error: "Not found." });
              return;
            }
            if (!tokenMatches(req.headers.authorization, config.review.token ?? "")) {
              send(res, 401, { success: false, error: "Unauthorized." });
              return;
            }
            const body = await readBody(req);
            const event = normalizeEvent(body);
            const result = await handleEvent(event);
            send(res, 200, result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger?.error({ err: error, path }, "review request failed");
            send(res, 500, { success: false, error: message });
          }
        })();
      });

      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(config.review.port, config.review.host, () => {
          server?.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      port = typeof address === "object" && address ? address.port : config.review.port;
      started = true;
      logger?.info(
        { host: config.review.host, port, topK: config.review.topK },
        "review server listening",
      );
    },
    async stop() {
      if (!started || !server) {
        return;
      }
      const current = server;
      server = undefined;
      started = false;
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
      });
      await engine.close();
    },
  };
}
