import { describe, expect, it } from "vitest";
import { parseRobotMessage } from "./parse";

describe("parseRobotMessage", () => {
  it("parses a group text message", () => {
    const message = parseRobotMessage({
      msgtype: "text",
      msgId: "m1",
      conversationId: "c1",
      conversationType: "2",
      senderStaffId: "u1",
      senderNick: "Alice",
      createAt: 123,
      sessionWebhook: "https://example.com/hook",
      sessionWebhookExpiredTime: 456,
      text: { content: "  hello  " },
    });

    expect(message).toEqual({
      messageId: "m1",
      conversationId: "c1",
      conversationType: "group",
      senderId: "u1",
      senderName: "Alice",
      text: "hello",
      createdAt: 123,
      replyWebhook: "https://example.com/hook",
      replyWebhookExpiresAt: 456,
    });
  });

  it("maps non-group conversations to single", () => {
    const message = parseRobotMessage({
      msgtype: "text",
      msgId: "m1",
      conversationId: "c1",
      conversationType: "1",
      senderId: "u2",
      text: { content: "hi" },
    });
    expect(message?.conversationType).toBe("single");
  });

  it("rejects non-text messages", () => {
    expect(
      parseRobotMessage({ msgtype: "image", msgId: "m1", conversationId: "c1" }),
    ).toBeUndefined();
  });

  it("rejects messages missing required fields", () => {
    expect(parseRobotMessage({ msgtype: "text", text: { content: "hi" } })).toBeUndefined();
  });
});
