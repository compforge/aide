export interface ChatMessage {
  id: string;
  chatId: string;
  threadId?: string;
  parentId?: string;
  rootId?: string;
  threadPosition?: string;
  sender: { id: string; type: string; name?: string };
  content: string;
  createdAt: string;
  updatedAt?: string;
  mentions: string[];
  deleted: boolean;
  url?: string;
}

export interface MessageQuery {
  start: string;
  end: string;
  pageToken?: string;
  limit?: number;
}

/** IM search filters are independent of the Personal observation policies. */
export interface MessageSearchQuery extends MessageQuery {
  chatType?: "p2p" | "group";
  atMe?: boolean;
}

/** A page is complete only when the provider reports no continuation or enrichment gap. */
export interface MessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
  nextToken?: string;
  observedThrough: string;
}

export interface MessageConnector {
  /** Confirms the configured account before reading with its user credentials. */
  identity(): Promise<{ accountId: string; userId: string }>;
  search(query: MessageSearchQuery): Promise<MessagePage>;
  history(query: MessageQuery & { chatId: string; order?: "asc" | "desc" }): Promise<MessagePage>;
  thread(query: { threadId: string; pageToken?: string; limit?: number; order?: "asc" | "desc" }): Promise<MessagePage>;
}
