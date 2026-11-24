export interface IncomingChatMessage {
  messageId: string;
  conversationId: string;
  conversationType: "single" | "group";
  senderId: string;
  senderName?: string;
  text: string;
  createdAt: number;
  replyWebhook?: string;
  replyWebhookExpiresAt?: number;
}

export interface OutgoingChatMessage {
  conversationId: string;
  text: string;
  format?: "text" | "markdown";
  title?: string;
}

export type ChatMessageHandler = (message: IncomingChatMessage) => Promise<void>;

export interface ChatChannel {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutgoingChatMessage): Promise<void>;
  onMessage(handler: ChatMessageHandler): () => void;
}

export interface DingTalkChannelOptions {
  clientId: string;
  clientSecret: string;
  robotCode?: string;
  fetchImpl?: typeof fetch;
  onError?: (error: Error) => void;
}
