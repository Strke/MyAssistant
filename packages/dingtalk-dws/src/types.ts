export interface DwsMessage {
  messageId: string;
  conversationId: string;
  threadId?: string;
  sender?: string;
  senderId?: string;
  senderType?: string;
  messageType?: string;
  text: string;
  createTime?: string;
  updateTime?: string;
  quotedMessage?: unknown;
  resourceRefs?: unknown;
}

export interface DwsFailure {
  page?: number;
  stage?: string;
  error?: string;
}

export interface DwsMessagePage {
  messages: DwsMessage[];
  complete: boolean;
  hasMore: boolean;
  nextPage?: unknown;
  stopReason?: string;
  truncated?: boolean;
  truncatedByPageLimit?: boolean;
  truncatedByResultLimit?: boolean;
  partial?: boolean;
  pagesFetched?: number;
  count: number;
  skipped: number;
  failedCount: number;
  failures: DwsFailure[];
  queryRange?: unknown;
}

export interface DwsChat {
  openConversationId: string;
  name?: string;
  type?: string;
  nameKnown?: boolean;
}

export interface DwsAuthStatus {
  authenticated: boolean;
  message?: string;
  version?: string;
}

export interface DwsHealth {
  service: string;
  version: string;
  uptimeMs: number;
  authenticated?: boolean;
  authMessage?: string;
}

export interface ListMessagesInput {
  groupId?: string;
  userId?: string;
  openDingTalkId?: string;
  start?: string;
  end?: string;
  order?: "asc" | "desc";
  pageAll?: boolean;
  pageLimit?: number;
  maxItems?: number;
  limit?: number;
}
