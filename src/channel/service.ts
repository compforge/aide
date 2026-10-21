import type { ConversationStore } from "../../plugins/personal/conversation/store.ts";
import type { CoreSession } from "../host/core/index.ts";
import type { HarnessInvocationSnapshot } from "../host/plugin/harness-invocation.ts";
import type { InputRequest } from "../host/message/types.ts";
import type { InputReceipt, InputSpec } from "@compforge/aide-plugin";
import type { Incoming, Message } from "./message.ts";

/** Channel-facing Core projections and input port; independent of any particular Controller or Harness. */
export interface ChannelSession {
  readonly id: string;
  readonly core: CoreSession;
  readonly conversations: ConversationStore;
}
export interface ChannelService {
  sessions(): readonly ChannelSession[];
  findConversation(conversationId: string): ChannelSession | undefined;
  subscribe(listener: () => void): () => void;
  receive(input: Incoming): Promise<InputReceipt>;
  inputDefinition(origin: Pick<InputSpec, "origin" | "originId">): { id: string; label: string; icon: string };
  messages(): Message[];
  messageDelivered?(conversationId: string, messageId: string): Promise<void>;
  questions(): { conversationId: string; request: InputRequest }[];
  invocations(): readonly HarnessInvocationSnapshot[];
  conversationIds(): string[];
}
