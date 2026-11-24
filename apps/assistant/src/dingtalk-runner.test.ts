import type {
  ChatChannel,
  ChatMessageHandler,
  IncomingChatMessage,
  OutgoingChatMessage,
} from "@myassistant/channel-dingtalk";
import { loadConfig } from "@myassistant/config";
import type { AgentSession } from "@myassistant/core";
import { describe, expect, it } from "vitest";
import { createDingTalkRunner } from "./dingtalk-runner";

class FakeChannel implements ChatChannel {
  readonly sent: OutgoingChatMessage[] = [];
  private handler: ChatMessageHandler | undefined;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(message: OutgoingChatMessage): Promise<void> {
    this.sent.push(message);
  }
  onMessage(handler: ChatMessageHandler): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }
  async deliver(message: IncomingChatMessage): Promise<void> {
    await this.handler?.(message);
  }
}

class FakeSession {
  disposed = false;
  readonly prompts: string[] = [];

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }
  getLastAssistantText(): string {
    return `reply:${this.prompts.at(-1) ?? ""}`;
  }
  dispose(): void {
    this.disposed = true;
  }
}

function message(conversationId: string, text: string, index = 1): IncomingChatMessage {
  return {
    messageId: `msg-${conversationId}-${index}`,
    conversationId,
    conversationType: "single",
    senderId: "user-1",
    text,
    createdAt: Date.now(),
  };
}

async function waitFor(fn: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}

function createHarness(options: {
  rateLimitPerMinute?: number;
  maxMessageChars?: number;
  sessionIdleMs?: number;
  maxSessions?: number;
}) {
  const channel = new FakeChannel();
  const sessions: FakeSession[] = [];
  const runner = createDingTalkRunner({
    config: loadConfig({}),
    channel,
    customTools: [],
    rateLimitPerMinute: options.rateLimitPerMinute ?? 0,
    maxMessageChars: options.maxMessageChars ?? 8_000,
    sessionIdleMs: options.sessionIdleMs ?? 0,
    maxSessions: options.maxSessions ?? 0,
    sweepIntervalMs: 1_000_000,
    createSession: async () => {
      const session = new FakeSession();
      sessions.push(session);
      return session as unknown as AgentSession;
    },
  });
  return { channel, sessions, runner };
}

describe("createDingTalkRunner", () => {
  it("rate limits a noisy conversation and only sends one notice", async () => {
    const { channel, sessions, runner } = createHarness({ rateLimitPerMinute: 1 });
    await runner.start();

    await channel.deliver(message("c1", "hello", 1));
    await waitFor(() => channel.sent.length === 1);
    await channel.deliver(message("c1", "again", 2));
    await waitFor(() => channel.sent.length === 2);
    await channel.deliver(message("c1", "third", 3));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[1]?.text).toContain("太频繁");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.prompts).toEqual(["hello"]);
    await runner.stop();
  });

  it("rejects overlong messages without creating a session", async () => {
    const { channel, sessions, runner } = createHarness({ maxMessageChars: 5 });
    await runner.start();

    await channel.deliver(message("c1", "123456"));
    await waitFor(() => channel.sent.length === 1);

    expect(channel.sent[0]?.text).toContain("太长");
    expect(sessions).toHaveLength(0);
    await runner.stop();
  });

  it("disposes idle sessions", async () => {
    const { channel, sessions, runner } = createHarness({ sessionIdleMs: 5 });
    await runner.start();

    await channel.deliver(message("c1", "hello"));
    await waitFor(() => channel.sent.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    runner.sweepIdleSessions();

    expect(sessions[0]?.disposed).toBe(true);
    await runner.stop();
  });

  it("evicts the least recently used session when the cache is full", async () => {
    const { channel, sessions, runner } = createHarness({ maxSessions: 1 });
    await runner.start();

    await channel.deliver(message("c1", "first"));
    await waitFor(() => channel.sent.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await channel.deliver(message("c2", "second"));
    await waitFor(() => channel.sent.length === 2);

    expect(sessions[0]?.disposed).toBe(true);
    expect(sessions[1]?.disposed).toBe(false);
    await runner.stop();
  });
});
