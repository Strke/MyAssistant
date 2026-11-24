import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ChatChannel, IncomingChatMessage } from "@myassistant/channel-dingtalk";
import { SlidingWindowRateLimiter } from "@myassistant/channel-dingtalk";
import type { AppConfig } from "@myassistant/config";
import {
  type AgentSession,
  type ConversationRecord,
  createAssistantSession,
  type Logger,
  type ToolDefinition,
} from "@myassistant/core";

export interface DingTalkRunnerOptions {
  config: AppConfig;
  channel: ChatChannel;
  customTools: ToolDefinition[] | ((conversationId: string) => ToolDefinition[]);
  onMessage?: (record: ConversationRecord) => Promise<void>;
  logger?: Logger;
  /** Maximum inbound messages per conversation per minute. 0 disables the limit. */
  rateLimitPerMinute?: number;
  /** Reject messages longer than this many characters. */
  maxMessageChars?: number;
  /** Dispose sessions idle for this long. 0 disables eviction. */
  sessionIdleMs?: number;
  /** Maximum cached sessions; least recently used idle sessions are evicted. 0 disables. */
  maxSessions?: number;
  /** Interval for idle-session sweeps. Defaults to at most one minute. */
  sweepIntervalMs?: number;
  /** Injection point for tests. */
  createSession?: (conversationId: string) => Promise<AgentSession>;
}

export interface DingTalkRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Run an idle-session sweep now. */
  sweepIdleSessions(): void;
}

function conversationDirName(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 24);
}

export function createDingTalkRunner(options: DingTalkRunnerOptions): DingTalkRunner {
  const sessions = new Map<string, AgentSession>();
  const lastUsed = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();
  const busy = new Map<string, number>();
  const rateLimitNotices = new Map<string, number>();
  const sessionRoot = join(options.config.agent.workspace, "data", "dingtalk-sessions");
  const onMessage = options.onMessage;
  const logger = options.logger;
  const maxMessageChars = options.maxMessageChars ?? 8_000;
  const idleMs = options.sessionIdleMs ?? 0;
  const maxSessions = options.maxSessions ?? 0;
  const limiter = new SlidingWindowRateLimiter({
    limit: options.rateLimitPerMinute ?? 0,
    windowMs: 60_000,
  });
  let writing: Promise<void> = Promise.resolve();
  const queueWrite = (record: ConversationRecord) => {
    if (!onMessage) {
      return;
    }
    writing = writing
      .then(() => onMessage(record))
      .catch((error) => {
        logger?.error({ err: error }, "failed to persist dingtalk message");
      });
  };
  let unsubscribe: (() => void) | undefined;
  let sweepTimer: NodeJS.Timeout | undefined;
  let stopping = false;

  const disposeSession = (conversationId: string) => {
    const session = sessions.get(conversationId);
    if (!session) {
      return;
    }
    session.dispose();
    sessions.delete(conversationId);
    lastUsed.delete(conversationId);
    queues.delete(conversationId);
    logger?.info({ conversationId }, "disposed idle dingtalk session");
  };

  const evictForCapacity = () => {
    if (maxSessions <= 0 || sessions.size < maxSessions) {
      return;
    }
    const candidates = [...sessions.entries()]
      .filter(([conversationId]) => (busy.get(conversationId) ?? 0) === 0)
      .sort(([left], [right]) => (lastUsed.get(left) ?? 0) - (lastUsed.get(right) ?? 0));
    for (const [conversationId] of candidates) {
      if (sessions.size < maxSessions) {
        break;
      }
      disposeSession(conversationId);
    }
    if (sessions.size >= maxSessions) {
      logger?.warn(
        { maxSessions },
        "all dingtalk sessions are busy; exceeding session cache limit",
      );
    }
  };

  const createSession = async (conversationId: string): Promise<AgentSession> => {
    if (options.createSession) {
      return options.createSession(conversationId);
    }
    const tools =
      typeof options.customTools === "function"
        ? options.customTools(conversationId)
        : options.customTools;
    const { session } = await createAssistantSession({
      config: options.config,
      customTools: tools,
      sessionDir: join(sessionRoot, conversationDirName(conversationId)),
      logger,
    });
    return session;
  };

  const sweepIdleSessions = () => {
    if (idleMs <= 0) {
      return;
    }
    const now = Date.now();
    for (const [conversationId] of sessions) {
      if ((busy.get(conversationId) ?? 0) > 0) {
        continue;
      }
      if (now - (lastUsed.get(conversationId) ?? now) < idleMs) {
        continue;
      }
      disposeSession(conversationId);
    }
  };

  const getSession = async (conversationId: string): Promise<AgentSession> => {
    const existing = sessions.get(conversationId);
    if (existing) {
      lastUsed.set(conversationId, Date.now());
      return existing;
    }
    evictForCapacity();
    const session = await createSession(conversationId);
    sessions.set(conversationId, session);
    lastUsed.set(conversationId, Date.now());
    return session;
  };

  const report = (error: unknown) => {
    logger?.error({ err: error }, "dingtalk message handling failed");
  };

  const record = (entry: ConversationRecord) => {
    queueWrite(entry);
  };

  const handle = async (message: IncomingChatMessage): Promise<void> => {
    if (stopping) {
      return;
    }
    if (message.text.length > maxMessageChars) {
      await options.channel.send({
        conversationId: message.conversationId,
        text: `消息太长（${message.text.length} 字符），请控制在 ${maxMessageChars} 字符以内。`,
      });
      return;
    }

    const decision = limiter.check(message.conversationId);
    if (!decision.allowed) {
      const now = Date.now();
      const lastNotice = rateLimitNotices.get(message.conversationId) ?? 0;
      if (now - lastNotice >= 60_000) {
        rateLimitNotices.set(message.conversationId, now);
        const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1_000));
        await options.channel.send({
          conversationId: message.conversationId,
          text: `消息太频繁，请 ${seconds} 秒后再试。`,
        });
      }
      return;
    }

    const session = await getSession(message.conversationId);
    lastUsed.set(message.conversationId, Date.now());
    const conversationId = `dingtalk:${message.conversationId}`;

    record({
      id: `dingtalk:${message.messageId}`,
      conversationId,
      role: "user",
      channel: "dingtalk",
      sender: message.senderName ?? message.senderId,
      externalId: message.messageId,
      content: message.text,
      createdAt: message.createdAt,
    });

    await session.prompt(message.text);
    const reply = session.getLastAssistantText()?.trim() || "（没有生成回复）";

    record({
      id: `dingtalk:${message.messageId}:assistant`,
      conversationId,
      role: "assistant",
      channel: "dingtalk",
      sender: "assistant",
      content: reply,
      createdAt: Date.now(),
    });

    await options.channel.send({ conversationId: message.conversationId, text: reply });
  };

  const enqueue = (message: IncomingChatMessage): void => {
    const conversationId = message.conversationId;
    busy.set(conversationId, (busy.get(conversationId) ?? 0) + 1);
    lastUsed.set(conversationId, Date.now());
    const previous = queues.get(conversationId) ?? Promise.resolve();
    const next = previous
      .then(() => handle(message))
      .catch(async (error) => {
        report(error);
        if (stopping) {
          return;
        }
        await options.channel
          .send({ conversationId, text: "处理失败，请稍后再试。" })
          .catch(report);
      })
      .finally(() => {
        const remaining = (busy.get(conversationId) ?? 1) - 1;
        if (remaining <= 0) {
          busy.delete(conversationId);
        } else {
          busy.set(conversationId, remaining);
        }
        lastUsed.set(conversationId, Date.now());
      });
    queues.set(conversationId, next);
  };

  return {
    async start(): Promise<void> {
      unsubscribe = options.channel.onMessage((message) => {
        enqueue(message);
        return Promise.resolve();
      });
      await options.channel.start();
      if (idleMs > 0) {
        const interval = options.sweepIntervalMs ?? Math.max(1_000, Math.min(60_000, idleMs / 2));
        sweepTimer = setInterval(sweepIdleSessions, interval);
        sweepTimer.unref?.();
      }
    },
    async stop(): Promise<void> {
      stopping = true;
      unsubscribe?.();
      unsubscribe = undefined;
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      const pendingQueues = [...queues.values()];
      for (const session of sessions.values()) {
        session.dispose();
      }
      sessions.clear();
      lastUsed.clear();
      queues.clear();
      busy.clear();
      rateLimitNotices.clear();
      limiter.reset();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(pendingQueues),
        new Promise<void>((resolvePromise) => {
          timer = setTimeout(resolvePromise, 5_000);
          timer.unref?.();
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
      }
      await writing;
      await options.channel.stop();
    },
    sweepIdleSessions,
  };
}
