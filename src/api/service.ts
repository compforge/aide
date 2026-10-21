import type { ChannelService } from "../channel/service.ts";
import type { Incoming } from "../channel/message.ts";

/** Product-specific sidebar and external event input supplied by application composition. */
export interface WebService extends ChannelService {
  readonly persons: import("../../plugins/personal/person/service.ts").Persons;
  start(): Promise<void>;
  deleteConversation(conversationId: string, revision: number, uid: string): Promise<import("../../plugins/personal/conversation/model.ts").ConversationDeletion>;
  setDefaultConversation(conversationId: string, enabled: boolean): Promise<void>;
  setConversationTrigger(conversationId: string, enabled: boolean): Promise<import("../../plugins/personal/conversation/trigger.ts").ConversationTrigger>;
  works(): readonly { id: string; conversationId: string; revision: number }[];
  event(input: Omit<Incoming, "channelId"> & { name: string }): Promise<number>;
  work(conversationId: string): { delete(id: string, revision: number): Promise<void> };
}
