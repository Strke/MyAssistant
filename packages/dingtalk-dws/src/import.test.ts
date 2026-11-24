import type { ChatMessageRecord, RagStore } from "@myassistant/rag";
import { describe, expect, it } from "vitest";
import { importDwsMessages } from "./import";
import type { DwsMessage } from "./types";

class FakeStore {
  readonly records: ChatMessageRecord[] = [];
  private readonly externalIds = new Set<string>();

  hasMessage(channel: string, externalId: string): boolean {
    return this.externalIds.has(`${channel}:${externalId}`);
  }

  async addMessage(record: ChatMessageRecord): Promise<void> {
    if (record.externalId) {
      this.externalIds.add(`${record.channel}:${record.externalId}`);
    }
    this.records.push(record);
  }

  async search(): Promise<[]> {
    return [];
  }

  async close(): Promise<void> {}
}

const base: DwsMessage = {
  messageId: "msg-1",
  conversationId: "cid-1",
  sender: "Alice",
  senderId: "u1",
  senderType: "user",
  messageType: "text",
  text: "hello",
  createTime: "2026-01-01 10:00:00",
};

describe("importDwsMessages", () => {
  it("maps DWS messages to RAG records with stable external ids", async () => {
    const store = new FakeStore();
    const result = await importDwsMessages(store as unknown as RagStore, [base], {
      now: () => 1,
    });

    expect(result).toMatchObject({ imported: 1, duplicates: 0, skipped: 0, failed: 0 });
    expect(store.records[0]).toMatchObject({
      id: "dws:msg-1",
      conversationId: "dingtalk:cid-1",
      channel: "dingtalk",
      externalId: "msg-1",
      role: "user",
      sender: "Alice",
      content: "hello",
    });
    expect(store.records[0]?.createdAt).toBeGreaterThan(0);
  });

  it("skips duplicates and empty messages", async () => {
    const store = new FakeStore();
    await importDwsMessages(
      store as unknown as RagStore,
      [base, { ...base, messageId: "msg-2", text: "   " }, { ...base, text: "again" }],
      { now: () => 1 },
    );

    expect(store.records).toHaveLength(1);
  });

  it("marks robot senders as assistant messages", async () => {
    const store = new FakeStore();
    await importDwsMessages(
      store as unknown as RagStore,
      [{ ...base, messageId: "msg-bot", senderType: "robot" }],
      { now: () => 1 },
    );
    expect(store.records[0]?.role).toBe("assistant");
  });
});
