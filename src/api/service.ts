import type { ChannelService } from "../channel/service.ts";
import type { Incoming } from "../channel/message.ts";

/** Product-specific sidebar and external event input supplied by application composition. */
export interface WebService extends ChannelService {
  health(): { status: "ok" | "unavailable"; unavailablePlugins: string[] };
  defaultAddress(): import("../../plugins/personal/address/model.ts").AddressRef;
  validateDefaultAddress(ref: import("../../plugins/personal/address/model.ts").AddressRef): Promise<void>;
  readonly usageStore?: import("../../plugins/personal/observation/usage-store.ts").UsageStore;
  readSession?: import("../../plugins/personal/observation/session.ts").ReadSession;
  readonly addresses: import("../../plugins/personal/address/service.ts").Addresses;
  readonly persons: import("../../plugins/personal/person/service.ts").Persons;
  start(): Promise<void>;
  deleteTopic(topicId: string, revision: number, uid: string): Promise<import("../../plugins/personal/topic/model.ts").TopicDeletion>;
  setTopicReview(topicId: string, enabled: boolean): Promise<import("../../plugins/personal/topic/review.ts").TopicReview>;
  works(topicId?: string): readonly { id: string; topicId: string; revision: number; kind: "task" | "routine" }[];
  event(input: Omit<Incoming, "channelId" | "source"> & { name: string }): Promise<number>;
  appendOngoingSupplement(id: string, text: string, key?: string): Promise<{ inputId: string }>;
  work(topicId: string): Pick<import("../../plugins/personal/work/service.ts").WorkService, "delete" | "listItems">;
}
