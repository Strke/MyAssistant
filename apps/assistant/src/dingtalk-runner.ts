import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ChatChannel, IncomingChatMessage } from "@myassistant/channel-dingtalk";
import type { AppConfig } from "@myassistant/config";
import {
  type AgentSession,
  type ConversationRecord,
  createAssistantSession,
  type ToolDefinition,
} from "@myassistant/core";

export interface DingTalkRunnerOptions {
  config: AppConfig;
  channel: ChatChannel;
  customTools: ToolDefinition[];
  onMessage?: (record: ConversationRecord) => Promise<void>;
}

export interface DingTalkRunner {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function conversationDirName(conversationId: string): string {
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 24);
}

export function createDingTalkRunner(options: DingTalkRunnerOptions): DingTalkRunner {
  const sessions = new Map<string, AgentSession>();
  const queues = new Map<string, Promise<void>>();
  const sessionRoot = join(options.config.agent.workspace, "data", "dingtalk-sessions");
  const onMessage = options.onMessage;
  let writing: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | undefined;

  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[dingtalk] ${message}\n`);
  };

  const record = (entry: ConversationRecord) => {
    if (!onMessage) {
      return;
    }
    writing = writing.then(() => onMessage(entry)).catch(report);
  };

  const getSession = async (conversationId: string): Promise<AgentSession> => {
    const existing = sessions.get(conversationId);
    if (existing) {
      return existing;
    }
    const { session } = await createAssistantSession({
      config: options.config,
      customTools: options.customTools,
      sessionDir: join(sessionRoot, conversationDirName(conversationId)),
    });
    sessions.set(conversationId, session);
    return session;
  };

  const handle = async (message: IncomingChatMessage): Promise<void> => {
    const session = await getSession(message.conversationId);
    const conversationId = `dingtalk:${message.conversationId}`;

    record({
      id: `dingtalk:${message.messageId}`,
      conversationId,
      role: "user",
      channel: "dingtalk",
      sender: message.senderName ?? message.senderId,
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
    const previous = queues.get(message.conversationId) ?? Promise.resolve();
    const next = previous
      .then(() => handle(message))
      .catch(async (error) => {
        report(error);
        await options.channel
          .send({ conversationId: message.conversationId, text: "处理失败，请稍后再试。" })
          .catch(report);
      });
    queues.set(message.conversationId, next);
  };

  return {
    async start(): Promise<void> {
      unsubscribe = options.channel.onMessage((message) => {
        enqueue(message);
        return Promise.resolve();
      });
      await options.channel.start();
    },
    async stop(): Promise<void> {
      unsubscribe?.();
      unsubscribe = undefined;
      await Promise.allSettled([...queues.values()]);
      for (const session of sessions.values()) {
        session.dispose();
      }
      sessions.clear();
      await writing;
      await options.channel.stop();
    },
  };
}
