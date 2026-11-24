import type { ChatMessageRecord, RagStore } from "@myassistant/rag";
import type { DwsMessage } from "./types";

export interface ImportDwsMessagesOptions {
  /** Used when a message lacks a conversation id. */
  conversationId?: string;
  maxContentChars?: number;
  now?: () => number;
}

export interface ImportDwsMessagesResult {
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
  errors: string[];
}

function parseTime(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  if (/^\d+$/.test(value)) {
    const number = Number(value);
    return number < 1_000_000_000_000 ? number * 1_000 : number;
  }
  const timestamp = Date.parse(value.replace(" ", "T"));
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function isAssistantSender(message: DwsMessage): boolean {
  const type = `${message.senderType ?? ""} ${message.messageType ?? ""}`.toLowerCase();
  return type.includes("robot") || type.includes("bot") || type.includes("ai");
}

function normalizeContent(message: DwsMessage, maxChars: number): string {
  return message.text.trim().slice(0, maxChars);
}

export async function importDwsMessages(
  store: RagStore,
  messages: DwsMessage[],
  options: ImportDwsMessagesOptions = {},
): Promise<ImportDwsMessagesResult> {
  const result: ImportDwsMessagesResult = {
    imported: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };
  const maxContentChars = options.maxContentChars ?? 20_000;
  const now = options.now ?? Date.now;

  for (const message of messages) {
    const conversationId = message.conversationId || options.conversationId;
    const content = normalizeContent(message, maxContentChars);
    if (!message.messageId || !conversationId || !content) {
      result.skipped += 1;
      continue;
    }

    if (store.hasMessage?.("dingtalk", message.messageId)) {
      result.duplicates += 1;
      continue;
    }

    const createdAt = parseTime(message.createTime, now());
    const record: ChatMessageRecord = {
      id: `dws:${message.messageId}`,
      conversationId: `dingtalk:${conversationId}`,
      role: isAssistantSender(message) ? "assistant" : "user",
      sender: message.sender ?? message.senderId,
      channel: "dingtalk",
      externalId: message.messageId,
      content,
      createdAt,
    };

    try {
      await store.addMessage(record);
      result.imported += 1;
    } catch (error) {
      result.failed += 1;
      const text = error instanceof Error ? error.message : String(error);
      if (result.errors.length < 10) {
        result.errors.push(`${message.messageId}: ${text}`);
      }
    }
  }

  return result;
}
