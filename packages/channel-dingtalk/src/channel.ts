import { DWClient, type DWClientDownStream, TOPIC_ROBOT } from "dingtalk-stream";
import { parseRobotMessage, type RawRobotMessage } from "./parse";
import type {
  ChatChannel,
  ChatMessageHandler,
  DingTalkChannelOptions,
  IncomingChatMessage,
  OutgoingChatMessage,
} from "./types";

interface WebhookRecord {
  url: string;
  expiresAt?: number;
}

const DEDUPE_TTL_MS = 10 * 60_000;

export class DingTalkChannel implements ChatChannel {
  private readonly options: DingTalkChannelOptions;
  private readonly handlers = new Set<ChatMessageHandler>();
  private readonly seen = new Map<string, number>();
  private readonly webhooks = new Map<string, WebhookRecord>();
  private readonly fetchImpl: typeof fetch;
  private client: DWClient | undefined;

  constructor(options: DingTalkChannelOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async start(): Promise<void> {
    if (this.client) {
      return;
    }

    const client = new DWClient({
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      debug: this.options.debug,
    });
    this.client = client;
    client.registerCallbackListener(TOPIC_ROBOT, (message) => {
      void this.handleCallback(client, message);
    });
    await client.connect();
  }

  async stop(): Promise<void> {
    this.client?.disconnect();
    this.client = undefined;
    this.handlers.clear();
  }

  onMessage(handler: ChatMessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async send(message: OutgoingChatMessage): Promise<void> {
    const webhook = this.webhooks.get(message.conversationId);
    if (!webhook) {
      throw new Error(
        `No reply webhook available for conversation ${message.conversationId}. The message may be too old for a passive reply.`,
      );
    }
    if (webhook.expiresAt && Date.now() >= webhook.expiresAt) {
      throw new Error("The reply webhook for this conversation has expired.");
    }

    const body =
      message.format === "markdown"
        ? {
            msgtype: "markdown",
            markdown: { title: message.title ?? "MyAssistant", text: message.text },
          }
        : { msgtype: "text", text: { content: message.text } };

    const response = await this.fetchImpl(webhook.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`DingTalk reply failed with HTTP ${response.status}.`);
    }

    const payload = (await response.json().catch(() => ({}))) as {
      errcode?: number;
      errmsg?: string;
    };
    if (payload.errcode && payload.errcode !== 0) {
      throw new Error(`DingTalk reply failed: ${payload.errmsg ?? payload.errcode}.`);
    }
  }

  private async handleCallback(client: DWClient, message: DWClientDownStream): Promise<void> {
    try {
      client.socketCallBackResponse(message.headers.messageId, { status: "SUCCESS" });
    } catch (error) {
      this.reportError(error);
    }

    let raw: RawRobotMessage;
    try {
      raw = JSON.parse(message.data) as RawRobotMessage;
    } catch (error) {
      this.reportError(error);
      return;
    }

    const incoming = parseRobotMessage(raw);
    if (!incoming) {
      await this.replyUnsupported(raw);
      return;
    }

    if (this.isDuplicate(incoming.messageId)) {
      return;
    }

    if (incoming.replyWebhook && incoming.conversationId) {
      this.webhooks.set(incoming.conversationId, {
        url: incoming.replyWebhook,
        expiresAt: incoming.replyWebhookExpiresAt,
      });
    }

    for (const handler of [...this.handlers]) {
      try {
        await handler(incoming);
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private async replyUnsupported(raw: RawRobotMessage): Promise<void> {
    if (!raw.conversationId || !raw.sessionWebhook) {
      return;
    }
    this.webhooks.set(raw.conversationId, {
      url: raw.sessionWebhook,
      expiresAt: raw.sessionWebhookExpiredTime,
    });
    await this.send({
      conversationId: raw.conversationId,
      text: "目前只支持文本消息。",
    }).catch((error) => {
      this.reportError(error);
    });
  }

  private isDuplicate(messageId: string): boolean {
    const now = Date.now();
    for (const [id, timestamp] of this.seen) {
      if (now - timestamp > DEDUPE_TTL_MS) {
        this.seen.delete(id);
      }
    }
    if (this.seen.has(messageId)) {
      return true;
    }
    this.seen.set(messageId, now);
    return false;
  }

  private reportError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (this.options.onError) {
      this.options.onError(normalized);
      return;
    }
    process.stderr.write(`[dingtalk] ${normalized.message}\n`);
  }
}

export function createDingTalkChannel(options: DingTalkChannelOptions): DingTalkChannel {
  return new DingTalkChannel(options);
}

export type { IncomingChatMessage };
