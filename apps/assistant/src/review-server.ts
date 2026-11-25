import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AppConfig } from "@myassistant/config";
import {
  createReviewEngine,
  type Logger,
  type ReviewConversationMessage,
  type ReviewDecision,
  type ReviewEngine,
} from "@myassistant/core";
import { createDwsGatewayClient } from "@myassistant/dingtalk-dws";
import type { ChatMessageRecord, MemoryHit, RagStore } from "@myassistant/rag";
import { BlackboardStore } from "./blackboard";
import { ConversationSummaryStore } from "./conversation-summary";
import { ReplyBlockStore } from "./reply-block";
import { isAcknowledgement, shouldAutoReply } from "./reply-policy";

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
  senderIsSelf?: boolean;
}

interface ReviewActions {
  blackboard?: {
    action: ReviewDecision["blackboardAction"];
    changed: boolean;
    taskId?: string;
  };
  pushed?: boolean;
  reply?: {
    sent: boolean;
    text?: string;
    error?: string;
  };
  skipped?: "self" | "covered";
}

interface ReviewResponse {
  duplicate: boolean;
  decision?: ReviewDecision;
  actions?: ReviewActions;
  conversationSummary?: string;
  batchSize?: number;
  batched?: boolean;
}

interface IngestedEvent {
  event: ReviewEvent;
  record: ChatMessageRecord;
  createdAt: number;
}

interface PendingReview {
  ingested: IngestedEvent;
  resolve: (response: ReviewResponse) => void;
  reject: (error: unknown) => void;
}

interface ConversationBatch {
  pending: PendingReview[];
  timer?: NodeJS.Timeout;
  firstAt: number;
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
    senderIsSelf: record.senderIsSelf === true,
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
  const blackboard = config.review.blackboardEnabled
    ? new BlackboardStore(config.review.blackboardPath, config.review.maxCompleted)
    : undefined;
  await blackboard?.init();
  const summaries = new ConversationSummaryStore(config.review.summaryPath);
  await summaries.init();
  const blocks = new ReplyBlockStore(config.review.blockPath);
  await blocks.init();
  const gateway =
    config.review.autoReply || config.review.blackboardEnabled
      ? createDwsGatewayClient({
          baseUrl: config.dws.gatewayUrl,
          token: config.dws.gatewayToken,
          timeoutMs: config.dws.requestTimeoutSeconds * 1_000,
        })
      : undefined;

  const toReviewMessage = (message: {
    role: string;
    sender?: string;
    content: string;
    createdAt: number;
  }): ReviewConversationMessage => ({
    role: message.role,
    sender: message.sender,
    content: message.content,
    createdAt: message.createdAt,
  });

  const loadConversationSummary = async (
    conversationId: string,
    excludeMessageIds: Set<string>,
  ): Promise<string> => {
    try {
      const existing = await summaries.get(conversationId);
      if (existing) {
        return existing;
      }
      const recent =
        (await store.recentMessages?.(
          conversationId,
          config.review.recentMessages + excludeMessageIds.size,
        )) ?? [];
      const prior = recent
        .filter((message) => !excludeMessageIds.has(message.id))
        .slice(-config.review.recentMessages);
      if (prior.length === 0) {
        return "";
      }
      const generated = (await engine.summarizeConversation(prior.map(toReviewMessage))).trim();
      if (generated) {
        await summaries.set(conversationId, generated);
      }
      return generated;
    } catch (error) {
      logger?.warn(
        { err: error },
        "conversation summary bootstrap failed; continuing without summary",
      );
      return "";
    }
  };

  const mergeConversationSummary = async (
    conversationId: string,
    messages: ReviewConversationMessage[],
  ): Promise<string> => {
    try {
      const updated = await summaries.update(conversationId, async (current) =>
        engine.updateConversationSummary({ previousSummary: current, messages }),
      );
      return updated ?? "";
    } catch (error) {
      logger?.warn({ err: error }, "conversation summary update failed; keeping previous summary");
      return (await summaries.get(conversationId).catch(() => undefined)) ?? "";
    }
  };

  const batches = new Map<string, ConversationBatch>();
  const processing = new Map<string, Promise<unknown>>();

  const toSummaryMessage = (ingested: IngestedEvent): ReviewConversationMessage => ({
    role: "user",
    sender: ingested.event.sender ?? ingested.event.senderOpenDingTalkId,
    content: ingested.event.content,
    createdAt: ingested.createdAt,
  });

  const combineContent = (ingested: IngestedEvent[]): string => {
    if (ingested.length === 1) {
      return ingested[0]?.event.content ?? "";
    }
    return ingested
      .map((item, index) => {
        const time = new Date(item.createdAt).toISOString();
        const sender = item.event.sender ?? item.event.senderOpenDingTalkId ?? "对方";
        return `[${index + 1}] ${time} ${sender}: ${item.event.content}`;
      })
      .join("\n");
  };

  const replyPolicy = (event: ReviewEvent): boolean =>
    shouldAutoReply(
      {
        chatType: event.chatType,
        conversationId: event.conversationId,
        senderOpenDingTalkId: event.senderOpenDingTalkId,
      },
      {
        enabled: config.review.autoReply,
        allowlist: config.review.autoReplyDms,
      },
    );

  const rememberBlock = async (
    conversationId: string,
    text: string,
    messageIds: string[],
  ): Promise<void> => {
    try {
      await blocks.set(conversationId, text, messageIds);
    } catch (error) {
      logger?.warn({ err: error }, "failed to persist reply block");
    }
  };

  const extendBlock = async (conversationId: string, messageIds: string[]): Promise<void> => {
    try {
      await blocks.extend(conversationId, messageIds);
    } catch (error) {
      logger?.warn({ err: error }, "failed to extend reply block");
    }
  };

  const processEvents = async (ingested: IngestedEvent[]): Promise<ReviewResponse> => {
    const primary = ingested[ingested.length - 1];
    if (!primary) {
      throw new Error("No messages to process.");
    }
    const conversationId = primary.record.conversationId;
    const excludeMessageIds = new Set(ingested.map((item) => item.record.id));
    const summaryUsed = await loadConversationSummary(conversationId, excludeMessageIds);
    const content = combineContent(ingested);
    const replyAllowed = replyPolicy(primary.event);
    const block = replyAllowed ? blocks.get(conversationId) : undefined;
    const previousReply =
      block &&
      config.review.blockContinuationSeconds > 0 &&
      Date.now() - block.repliedAt <= config.review.blockContinuationSeconds * 1_000
        ? block.text
        : undefined;

    let decision: ReviewDecision;
    if (previousReply && ingested.every((item) => isAcknowledgement(item.event.content))) {
      decision = {
        related: false,
        alreadyDone: false,
        coveredByPreviousReply: true,
        confidence: 1,
        reason: "纯确认/感谢消息，已被上一条回复覆盖",
        evidence: [],
        blackboardAction: "none",
      };
    } else {
      let hits: MemoryHit[] = [];
      try {
        hits = await store.search(content.slice(0, 4_000), { topK: config.review.topK });
      } catch (error) {
        logger?.warn({ err: error }, "review retrieval failed; continuing without memory");
      }
      const relatedHits = hits.filter((hit) => !excludeMessageIds.has(hit.messageId));
      const blackboardItems = blackboard
        ? blackboard.list().map((item) => ({
            id: item.id,
            title: item.title,
            status: item.status,
          }))
        : undefined;

      decision = await engine.judge({
        conversationSummary: summaryUsed,
        previousReply,
        message: {
          content,
          sender: primary.event.sender,
          conversationId: primary.event.conversationId,
          chatType: primary.event.chatType,
          createdAt: primary.createdAt,
        },
        hits: relatedHits.map((hit) => ({
          content: hit.content,
          createdAt: hit.createdAt,
          conversationId: hit.conversationId,
        })),
        blackboardItems,
      });
    }

    const actions: ReviewActions = {};
    const coveredByPreviousReply = Boolean(previousReply) && decision.coveredByPreviousReply;

    if (coveredByPreviousReply) {
      actions.skipped = "covered";
      await extendBlock(
        conversationId,
        ingested.map((item) => item.event.messageId),
      );
      const conversationSummary = await mergeConversationSummary(
        conversationId,
        ingested.map(toSummaryMessage),
      );
      logger?.info(
        {
          eventId: primary.event.eventId,
          messageId: primary.event.messageId,
          chatType: primary.event.chatType,
          batchSize: ingested.length,
          previousReplyUsed: true,
          coveredByPreviousReply: true,
          summaryUsedLength: summaryUsed.length,
          summaryLength: conversationSummary.length,
        },
        "review decision",
      );
      return {
        duplicate: false,
        decision,
        actions,
        conversationSummary,
        batchSize: ingested.length,
      };
    }

    if (blackboard && decision.related) {
      if (decision.blackboardAction === "add" && decision.blackboardItem) {
        const added = await blackboard.add({
          title: decision.blackboardItem.title,
          details: decision.blackboardItem.details,
          sourceMessageId: primary.event.messageId,
          sourceConversationId: primary.event.conversationId,
        });
        actions.blackboard = {
          action: "add",
          changed: added.changed,
          taskId: added.item.id,
        };
      } else if (decision.blackboardAction === "complete" && decision.completedTaskId) {
        const completed = await blackboard.complete(decision.completedTaskId);
        actions.blackboard = {
          action: "complete",
          changed: Boolean(completed),
          taskId: completed?.item.id,
        };
      } else {
        actions.blackboard = { action: "none", changed: false };
      }

      if (actions.blackboard.changed && config.review.blackboardGroupId && gateway) {
        try {
          await gateway.sendGroupMessage(config.review.blackboardGroupId, blackboard.render());
          actions.pushed = true;
        } catch (error) {
          logger?.error({ err: error }, "blackboard push failed");
        }
      }
    }

    if (replyAllowed && decision.related && gateway) {
      const defaultReply =
        decision.blackboardAction === "add"
          ? "收到，我先记到黑板上了。"
          : decision.alreadyDone
            ? "收到，这件事之前已经完成了。"
            : "收到，我确认一下。";
      const replyText = decision.suggestedReply?.trim() || defaultReply;
      try {
        await gateway.replyMessage({
          conversationId: primary.event.conversationId,
          messageId: primary.event.messageId,
          chatType: primary.event.chatType === "direct" ? "direct" : "group",
          senderOpenDingTalkId: primary.event.senderOpenDingTalkId,
          text: replyText,
        });
        actions.reply = { sent: true, text: replyText };
        await rememberBlock(
          conversationId,
          replyText,
          ingested.map((item) => item.event.messageId),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        actions.reply = { sent: false, text: replyText, error: message };
        logger?.error({ err: error }, "auto reply failed");
      }
    } else if (previousReply && !decision.related) {
      await extendBlock(
        conversationId,
        ingested.map((item) => item.event.messageId),
      );
    }

    const summaryMessages = ingested.map(toSummaryMessage);
    if (actions.reply?.sent && actions.reply.text) {
      summaryMessages.push({
        role: "assistant",
        sender: "我",
        content: actions.reply.text,
        createdAt: Date.now(),
      });
    }
    const conversationSummary = await mergeConversationSummary(conversationId, summaryMessages);

    logger?.info(
      {
        eventId: primary.event.eventId,
        messageId: primary.event.messageId,
        chatType: primary.event.chatType,
        batchSize: ingested.length,
        previousReplyUsed: Boolean(previousReply),
        coveredByPreviousReply: false,
        related: decision.related,
        alreadyDone: decision.alreadyDone,
        confidence: decision.confidence,
        blackboardAction: decision.blackboardAction,
        blackboardPushed: actions.pushed,
        autoReplyAllowed: replyAllowed,
        replied: actions.reply?.sent,
        summaryUsedLength: summaryUsed.length,
        summaryLength: conversationSummary.length,
      },
      "review decision",
    );
    return {
      duplicate: false,
      decision,
      actions,
      conversationSummary,
      batchSize: ingested.length,
    };
  };

  const flushBatch = async (key: string): Promise<void> => {
    const batch = batches.get(key);
    if (!batch) {
      return;
    }
    batches.delete(key);
    if (batch.timer) {
      clearTimeout(batch.timer);
    }
    const ingested = batch.pending.map((pending) => pending.ingested);
    const previous = processing.get(key) ?? Promise.resolve();
    const run = previous.then(
      () => processEvents(ingested),
      () => processEvents(ingested),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    processing.set(key, tail);
    try {
      const result = await run;
      batch.pending.forEach((pending, index) => {
        if (index === batch.pending.length - 1) {
          pending.resolve(result);
        } else {
          pending.resolve({
            duplicate: false,
            batched: true,
            batchSize: ingested.length,
            conversationSummary: result.conversationSummary,
          });
        }
      });
    } catch (error) {
      for (const pending of batch.pending) {
        pending.reject(error);
      }
    } finally {
      if (processing.get(key) === tail) {
        processing.delete(key);
      }
    }
  };

  const enqueue = (ingested: IngestedEvent): Promise<ReviewResponse> =>
    new Promise((resolve, reject) => {
      const key = ingested.record.conversationId;
      let batch = batches.get(key);
      if (!batch) {
        batch = { pending: [], firstAt: Date.now() };
        batches.set(key, batch);
      }
      batch.pending.push({ ingested, resolve, reject });
      if (batch.timer) {
        clearTimeout(batch.timer);
      }
      const maxMs = config.review.replyDebounceMaxSeconds * 1_000;
      const quietMs = config.review.replyDebounceSeconds * 1_000;
      const elapsed = Date.now() - batch.firstAt;
      const delay = Math.max(0, Math.min(quietMs, maxMs - elapsed));
      batch.timer = setTimeout(() => {
        void flushBatch(key);
      }, delay);
      batch.timer.unref?.();
    });

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

    if (event.senderIsSelf) {
      logger?.info(
        { messageId: event.messageId },
        "self message stored in RAG; skipped review actions and summary update",
      );
      return { duplicate: false, actions: { skipped: "self" } };
    }

    const ingested: IngestedEvent = { event, record, createdAt };
    if (config.review.replyDebounceSeconds > 0 && replyPolicy(event)) {
      return enqueue(ingested);
    }
    return processEvents([ingested]);
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
      for (const [key, batch] of batches) {
        if (batch.timer) {
          clearTimeout(batch.timer);
        }
        for (const pending of batch.pending) {
          pending.reject(new Error("Review server stopped before processing the message block."));
        }
        batches.delete(key);
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
