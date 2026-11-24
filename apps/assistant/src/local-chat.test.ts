import { loadConfig } from "@myassistant/config";
import type { AgentSession } from "@myassistant/core";
import type { ChatMessageRecord } from "@myassistant/rag";
import { describe, expect, it } from "vitest";
import { createLocalChatService, type LocalChatEventName } from "./local-chat";

class FakeSession {
  readonly sessionId = "session-1";
  disposed = false;
  private last = "";
  private listener: ((event: unknown) => void) | undefined;

  subscribe(listener: (event: unknown) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  async prompt(text: string): Promise<void> {
    this.listener?.({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: `reply:${text}` },
    });
    this.listener?.({ type: "tool_execution_start", toolName: "read" });
    this.last = `reply:${text}`;
  }
  getLastAssistantText(): string {
    return this.last;
  }
  async abort(): Promise<void> {}
  dispose(): void {
    this.disposed = true;
  }
}

describe("createLocalChatService", () => {
  it("streams deltas, records messages and reuses the session", async () => {
    const session = new FakeSession();
    const recorded: ChatMessageRecord[] = [];
    const service = createLocalChatService({
      config: loadConfig({}),
      customTools: [],
      createSession: async () => session as unknown as AgentSession,
      onMessage: async (record) => {
        recorded.push(record);
      },
    });

    const events: Array<[LocalChatEventName, string]> = [];
    const first = await service.chat(
      "default",
      "hello",
      (name, text) => events.push([name, text]),
      new AbortController().signal,
    );
    const second = await service.chat(
      "default",
      "again",
      () => undefined,
      new AbortController().signal,
    );

    expect(first).toBe("reply:hello");
    expect(second).toBe("reply:again");
    expect(events).toEqual([
      ["delta", "reply:hello"],
      ["status", "tool: read"],
    ]);
    expect(recorded.filter((record) => record.role === "user")).toHaveLength(2);
    expect(recorded.filter((record) => record.role === "assistant")).toHaveLength(2);
    expect(service.sessionCount()).toBe(1);

    service.dispose();
    expect(session.disposed).toBe(true);
  });

  it("evicts idle sessions", async () => {
    const session = new FakeSession();
    const service = createLocalChatService({
      config: loadConfig({}),
      customTools: [],
      idleMs: 1,
      createSession: async () => session as unknown as AgentSession,
    });
    await service.chat("default", "hello", () => undefined, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    service.sweepIdleSessions();

    expect(session.disposed).toBe(true);
    expect(service.sessionCount()).toBe(0);
  });
});
