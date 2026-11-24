import type { AppConfig } from "@myassistant/config";
import { createDwsGatewayClient, importDwsMessages } from "@myassistant/dingtalk-dws";
import { createEmbedder, openRagStore } from "@myassistant/rag";

export interface HistoryImportInput {
  groupId?: string;
  userId?: string;
  openDingTalkId?: string;
  since?: string;
  until?: string;
  maxItems?: number;
}

export interface HistoryImportSummary {
  target: string;
  since?: string;
  until?: string;
  fetched: number;
  complete: boolean;
  hasMore: boolean;
  stopReason?: string;
  failures: unknown[];
  imported: number;
  duplicates: number;
  skipped: number;
  failed: number;
  errors: string[];
  latestCreatedAt?: number;
}

export function formatDwsTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function parseDwsTime(value: string, fallback: number): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const number = Number(trimmed);
    return number < 1_000_000_000_000 ? number * 1_000 : number;
  }
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00`
    : trimmed.replace(" ", "T");
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function targetLabel(input: HistoryImportInput): string {
  if (input.groupId) {
    return `group:${input.groupId}`;
  }
  if (input.userId) {
    return `user:${input.userId}`;
  }
  return `openDingTalkId:${input.openDingTalkId ?? ""}`;
}

function latestCreatedAt(messages: Array<{ createTime?: string }>): number | undefined {
  let latest: number | undefined;
  for (const message of messages) {
    if (!message.createTime) {
      continue;
    }
    const timestamp = parseDwsTime(message.createTime, Number.NaN);
    if (Number.isFinite(timestamp) && (latest === undefined || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}

export async function importDingTalkHistory(
  config: AppConfig,
  input: HistoryImportInput,
): Promise<HistoryImportSummary> {
  if (!config.dws.enabled) {
    throw new Error("DWS is disabled. Set DWS_ENABLED=true in .env.");
  }
  if (!config.rag.enabled) {
    throw new Error("Historical DingTalk import requires RAG. Set RAG_ENABLED=true.");
  }
  const targetCount = [input.groupId, input.userId, input.openDingTalkId].filter(Boolean).length;
  if (targetCount !== 1) {
    throw new Error("Provide exactly one of --group, --user or --open-dingtalk-id.");
  }
  if (
    input.groupId &&
    config.dws.historyGroups.length > 0 &&
    !config.dws.historyGroups.includes(input.groupId)
  ) {
    throw new Error(
      `Group ${input.groupId} is not in DWS_HISTORY_GROUPS. Add it explicitly to allow importing this group.`,
    );
  }

  const until = input.until;
  const since = input.since;
  const client = createDwsGatewayClient({
    baseUrl: config.dws.gatewayUrl,
    token: config.dws.gatewayToken,
    timeoutMs: config.dws.requestTimeoutSeconds * 1_000,
  });
  const embedder = createEmbedder(config.rag.embedding);
  const store = openRagStore({ dbPath: config.rag.dbPath, embedder });

  try {
    const page = await client.listMessages({
      groupId: input.groupId,
      userId: input.userId,
      openDingTalkId: input.openDingTalkId,
      start: since,
      end: until,
      order: since ? "asc" : undefined,
      pageAll: true,
      pageLimit: config.dws.pageSize,
      maxItems: input.maxItems ?? config.dws.maxItemsPerSync,
    });
    const result = await importDwsMessages(store, page.messages, {
      conversationId: input.groupId ?? input.userId ?? input.openDingTalkId,
    });

    return {
      target: targetLabel(input),
      since,
      until,
      fetched: page.messages.length,
      complete: page.complete,
      hasMore: page.hasMore,
      stopReason: page.stopReason,
      failures: page.failures,
      imported: result.imported,
      duplicates: result.duplicates,
      skipped: result.skipped,
      failed: result.failed,
      errors: result.errors,
      latestCreatedAt: latestCreatedAt(page.messages),
    };
  } finally {
    await store.close();
  }
}
