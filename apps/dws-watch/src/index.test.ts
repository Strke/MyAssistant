import { describe, expect, it } from "vitest";
import { extractEvent, loadWatchConfig } from "./index";

describe("extractEvent", () => {
  it("extracts flat DWS event fields", () => {
    const event = extractEvent(
      {
        event_id: "event-1",
        message_id: "msg-1",
        conversation_id: "cid-1",
        sender: "Alice",
        sender_open_dingtalk_id: "u1",
        content: "hello",
        create_time: "2026-01-01 10:00:00",
      },
      "group:cid-1",
    );

    expect(event).toMatchObject({
      eventId: "event-1",
      messageId: "msg-1",
      conversationId: "cid-1",
      chatType: "group",
      sender: "Alice",
      senderOpenDingTalkId: "u1",
      content: "hello",
    });
    expect(event?.createdAt).toBeGreaterThan(0);
  });

  it("extracts nested payload fields and resolves text objects", () => {
    const event = extractEvent(
      {
        type: "message",
        payload: {
          messageId: "msg-2",
          conversationId: "cid-2",
          senderNick: "Bob",
          text: { content: "nested text" },
        },
      },
      "direct:all",
    );
    expect(event).toMatchObject({
      messageId: "msg-2",
      conversationId: "cid-2",
      content: "nested text",
      chatType: "direct",
    });
  });

  it("detects AI-sent messages for loop prevention", () => {
    const event = extractEvent(
      {
        message_id: "msg-ai",
        conversation_id: "cid",
        content: "assistant reply",
        message_ai_send_flag: true,
      },
      "group:cid",
    );
    expect(event?.aiSend).toBe(true);
  });

  it("rejects events without message id or content", () => {
    expect(extractEvent({ message_id: "msg-1", content: "x" }, "group:cid")).toBeUndefined();
    expect(
      extractEvent({ message_id: "msg-1", conversation_id: "cid" }, "group:cid"),
    ).toBeUndefined();
  });
});

describe("loadWatchConfig", () => {
  it("requires a review endpoint and token", () => {
    expect(() => loadWatchConfig({ DWS_WATCH_GROUPS: "cid" })).toThrow("A_REVIEW_URL");
    expect(() =>
      loadWatchConfig({ DWS_WATCH_GROUPS: "cid", A_REVIEW_URL: "https://a.example" }),
    ).toThrow("A_REVIEW_TOKEN");
  });

  it("supports a group watch and all direct messages", () => {
    const config = loadWatchConfig({
      A_REVIEW_URL: "https://a.example/",
      A_REVIEW_TOKEN: "token",
      DWS_WATCH_GROUPS: "cid-1,cid-2",
      DWS_WATCH_DMS: "all",
      DWS_WATCH_LOG: "/tmp/reviews.jsonl",
      DWS_WATCH_IGNORE_SENDERS: "邮箱助手, 钉钉助手",
    });
    expect(config.groups).toEqual(["cid-1", "cid-2"]);
    expect(config.watchAllDirect).toBe(true);
    expect([...config.ignoreSenders]).toEqual(["邮箱助手", "钉钉助手"]);
    expect(config.reviewUrl).toBe("https://a.example");
    expect(config.logPath).toBe("/tmp/reviews.jsonl");
  });
});
