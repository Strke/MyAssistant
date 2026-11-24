import type { IncomingChatMessage } from "./types";

export interface RawRobotMessage {
  msgtype?: string;
  msgId?: string;
  conversationId?: string;
  conversationType?: string;
  senderStaffId?: string;
  senderId?: string;
  senderNick?: string;
  createAt?: number;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  text?: { content?: string };
}

export function parseRobotMessage(
  raw: RawRobotMessage,
  now = Date.now(),
): IncomingChatMessage | undefined {
  if (raw.msgtype !== "text") {
    return undefined;
  }

  const text = raw.text?.content?.trim();
  const senderId = raw.senderStaffId || raw.senderId;
  if (!raw.msgId || !raw.conversationId || !senderId || !text) {
    return undefined;
  }

  return {
    messageId: raw.msgId,
    conversationId: raw.conversationId,
    conversationType: raw.conversationType === "2" ? "group" : "single",
    senderId,
    senderName: raw.senderNick || undefined,
    text,
    createdAt: raw.createAt || now,
    replyWebhook: raw.sessionWebhook || undefined,
    replyWebhookExpiresAt: raw.sessionWebhookExpiredTime || undefined,
  };
}
