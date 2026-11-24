export interface IncomingChatMessage {
  messageId: string;
  conversationId: string;
  conversationType: "single" | "group";
  senderId: string;
  senderName?: string;
  text: string;
  createdAt: number;
}

export interface OutgoingChatMessage {
  conversationId: string;
  text: string;
  format?: "text" | "markdown";
}

export type ChatMessageHandler = (message: IncomingChatMessage) => Promise<void>;

export interface ChatChannel {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutgoingChatMessage): Promise<void>;
  onMessage(handler: ChatMessageHandler): () => void;
}
