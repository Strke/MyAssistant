import { describe, expect, it } from "vitest";
import { createEmbedder } from "./embedder";
import { openRagStore } from "./store";

const hashEmbedder = () => createEmbedder({ provider: "hash", model: "hash", dimensions: 32 });

describe("SqliteRagStore", () => {
  it("stores messages and finds them by hybrid search", async () => {
    const store = openRagStore({ dbPath: ":memory:", embedder: hashEmbedder() });
    try {
      await store.addMessage({
        id: "m1",
        conversationId: "c1",
        role: "user",
        channel: "local",
        content: "我喜欢喝乌龙茶，每天早上都泡一杯。",
        createdAt: 1000,
      });
      await store.addMessage({
        id: "m2",
        conversationId: "c1",
        role: "user",
        channel: "local",
        content: "明天的会议改到下午三点。",
        createdAt: 2000,
      });

      const hits = await store.search("乌龙茶", { topK: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((hit) => hit.content.includes("乌龙茶"))).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("ignores duplicate messages", async () => {
    const store = openRagStore({ dbPath: ":memory:", embedder: hashEmbedder() });
    try {
      const message = {
        id: "m1",
        conversationId: "c1",
        role: "user" as const,
        channel: "local",
        content: "记住暗号是蓝鲸。",
        createdAt: 1000,
      };
      await store.addMessage(message);
      await store.addMessage(message);

      const hits = await store.search("蓝鲸", { topK: 10 });
      expect(hits).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("deduplicates messages by channel and external id", async () => {
    const store = openRagStore({ dbPath: ":memory:", embedder: hashEmbedder() });
    try {
      await store.addMessage({
        id: "m1",
        conversationId: "c1",
        role: "user",
        channel: "dingtalk",
        externalId: "msg-1",
        content: "第一条钉钉消息。",
        createdAt: 1000,
      });
      await store.addMessage({
        id: "m2",
        conversationId: "c1",
        role: "user",
        channel: "dingtalk",
        externalId: "msg-1",
        content: "重复导入的钉钉消息。",
        createdAt: 1000,
      });

      expect(store.hasMessage("dingtalk", "msg-1")).toBe(true);
      expect(store.hasMessage("dingtalk", "msg-2")).toBe(false);
      const hits = await store.search("钉钉消息", { topK: 10 });
      expect(hits).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("filters by conversation and timestamp", async () => {
    const store = openRagStore({ dbPath: ":memory:", embedder: hashEmbedder() });
    try {
      await store.addMessage({
        id: "m1",
        conversationId: "c1",
        role: "user",
        channel: "local",
        content: "项目甲下周上线。",
        createdAt: 1000,
      });
      await store.addMessage({
        id: "m2",
        conversationId: "c2",
        role: "user",
        channel: "local",
        content: "项目甲已上线。",
        createdAt: 5000,
      });

      const onlyConversation = await store.search("项目甲", { topK: 10, conversationId: "c2" });
      expect(onlyConversation).toHaveLength(1);
      expect(onlyConversation[0]?.conversationId).toBe("c2");

      const onlyRecent = await store.search("项目甲", { topK: 10, since: 3000 });
      expect(onlyRecent).toHaveLength(1);
      expect(onlyRecent[0]?.conversationId).toBe("c2");
    } finally {
      await store.close();
    }
  });
});
