import type { ConversationStore } from "../host/conversation/store.ts";
import type { CoreSession } from "../host/core/index.ts";
import type { HarnessInvocationSnapshot } from "../host/plugin/harness-invocation.ts";
import type { InputRequest } from "../host/message/types.ts";
import type { Incoming, Message } from "./message.ts";

/** Channel-facing Core projections and input port; independent of any particular Controller or Harness. */
export interface ChannelService {
  readonly core: CoreSession;
  readonly conversations: ConversationStore;
  receive(input: Incoming): Promise<Message>;
  messages(): Message[];
  questions(): { conversationId: string; request: InputRequest }[];
  invocations(): readonly HarnessInvocationSnapshot[];
  conversationIds(): string[];
}

/** Product-specific sidebar and external event input supplied by application composition. */
export interface WebService extends ChannelService {
  works(): readonly { conversationId: string }[];
  event(input: Incoming & { name: string }): Promise<number>;
}
