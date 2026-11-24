export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  sender?: string;
  channel: string;
  externalId?: string;
  content: string;
  createdAt: number;
}

export interface MemoryHit {
  chunkId: string;
  messageId: string;
  conversationId: string;
  content: string;
  score: number;
  createdAt: number;
}

export interface MemorySearchOptions {
  topK?: number;
  conversationId?: string;
  since?: number;
}

export interface RagStore {
  addMessage(record: ChatMessageRecord): Promise<void>;
  search(query: string, options?: MemorySearchOptions): Promise<MemoryHit[]>;
  /** Optional fast duplicate check by channel/external id. */
  hasMessage?(channel: string, externalId: string): boolean;
  close(): Promise<void>;
}
