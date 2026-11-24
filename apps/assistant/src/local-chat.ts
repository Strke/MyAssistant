import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AppConfig } from "@myassistant/config";
import {
  type AgentSession,
  createAssistantSession,
  type Logger,
  type ToolDefinition,
} from "@myassistant/core";
import type { ChatMessageRecord } from "@myassistant/rag";

export type LocalChatEventName = "delta" | "status";
export type LocalChatEmitter = (event: LocalChatEventName, text: string) => void;

export interface LocalChatServiceOptions {
  config: AppConfig;
  customTools: ToolDefinition[];
  onMessage?: (record: ChatMessageRecord) => Promise<void>;
  logger?: Logger;
  sessionDir?: string;
  idleMs?: number;
  createSession?: (conversationId: string) => Promise<AgentSession>;
}

export interface LocalChatService {
  chat(
    conversationId: string,
    text: string,
    emit: LocalChatEmitter,
    signal: AbortSignal,
  ): Promise<string>;
  sweepIdleSessions(): void;
  dispose(): void;
  sessionCount(): number;
}

interface CachedSession {
  session: AgentSession;
  lastUsed: number;
}

function conversationDirName(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 24);
}

export function createLocalChatService(options: LocalChatServiceOptions): LocalChatService {
  const config = options.config;
  const logger = options.logger;
  const idleMs = options.idleMs ?? 0;
  const sessionRoot = options.sessionDir ?? config.daemon.localSessionDir;
  const sessions = new Map<string, CachedSession>();
  const queues = new Map<string, Promise<unknown>>();
  const busy = new Map<string, number>();

  const createSession = async (conversationId: string): Promise<AgentSession> => {
    if (options.createSession) {
      return options.createSession(conversationId);
    }
    const { session } = await createAssistantSession({
      config,
      customTools: options.customTools,
      sessionDir: join(sessionRoot, conversationDirName(conversationId)),
      logger,
    });
    return session;
  };

  const getSession = async (conversationId: string): Promise<CachedSession> => {
    const existing = sessions.get(conversationId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    const session = await createSession(conversationId);
    const cached = { session, lastUsed: Date.now() };
    sessions.set(conversationId, cached);
    return cached;
  };

  const record = async (entry: ChatMessageRecord): Promise<void> => {
    if (!options.onMessage) {
      return;
    }
    try {
      await options.onMessage(entry);
    } catch (error) {
      logger?.error({ err: error }, "failed to persist local chat message");
    }
  };

  const run = async (
    conversationId: string,
    text: string,
    emit: LocalChatEmitter,
    signal: AbortSignal,
  ): Promise<string> => {
    signal.throwIfAborted();
    const cached = await getSession(conversationId);
    const session = cached.session;
    const ragConversationId = `local:${conversationId}`;
    const unsubscribe = session.subscribe((sessionEvent) => {
      if (
        sessionEvent.type === "message_update" &&
        sessionEvent.assistantMessageEvent.type === "text_delta"
      ) {
        emit("delta", sessionEvent.assistantMessageEvent.delta);
      }
      if (sessionEvent.type === "tool_execution_start") {
        emit("status", `tool: ${sessionEvent.toolName}`);
      }
    });
    const onAbort = () => {
      void session.abort().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const startedAt = Date.now();
    await record({
      id: `${session.sessionId}:user:${startedAt}`,
      conversationId: ragConversationId,
      role: "user",
      channel: "local",
      sender: "user",
      content: text,
      createdAt: startedAt,
    });

    try {
      await session.prompt(text);
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      const reply = session.getLastAssistantText()?.trim() || "（没有生成回复）";
      await record({
        id: `${session.sessionId}:assistant:${Date.now()}`,
        conversationId: ragConversationId,
        role: "assistant",
        channel: "local",
        sender: "assistant",
        content: reply,
        createdAt: Date.now(),
      });
      return reply;
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      cached.lastUsed = Date.now();
    }
  };

  const chat = (
    conversationId: string,
    text: string,
    emit: LocalChatEmitter,
    signal: AbortSignal,
  ): Promise<string> => {
    const previous = queues.get(conversationId) ?? Promise.resolve();
    busy.set(conversationId, (busy.get(conversationId) ?? 0) + 1);
    const next = previous.then(
      () => run(conversationId, text, emit, signal),
      () => run(conversationId, text, emit, signal),
    );
    const tracked = next.finally(() => {
      const remaining = (busy.get(conversationId) ?? 1) - 1;
      if (remaining <= 0) {
        busy.delete(conversationId);
        queues.delete(conversationId);
      } else {
        busy.set(conversationId, remaining);
      }
    });
    queues.set(
      conversationId,
      tracked.catch(() => undefined),
    );
    return tracked;
  };

  return {
    chat,
    sweepIdleSessions() {
      if (idleMs <= 0) {
        return;
      }
      const now = Date.now();
      for (const [conversationId, cached] of sessions) {
        if (now - cached.lastUsed < idleMs) {
          continue;
        }
        if ((busy.get(conversationId) ?? 0) > 0) {
          continue;
        }
        cached.session.dispose();
        sessions.delete(conversationId);
        logger?.info({ conversationId }, "disposed idle local session");
      }
    },
    dispose() {
      for (const cached of sessions.values()) {
        cached.session.dispose();
      }
      sessions.clear();
      queues.clear();
      busy.clear();
    },
    sessionCount() {
      return sessions.size;
    },
  };
}
