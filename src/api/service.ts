import type { ChannelService } from "../channel/service.ts";
import type { Incoming } from "../channel/message.ts";

/** Product-specific sidebar and external event input supplied by application composition. */
export interface WebService extends ChannelService {
  readonly persons: import("../../plugins/personal/person/service.ts").Persons;
  start(): Promise<void>;
  deleteTopic(topicId: string, revision: number, uid: string): Promise<import("../../plugins/personal/topic/model.ts").TopicDeletion>;
  setDefaultTopic(topicId: string, enabled: boolean): Promise<void>;
  setTopicTrigger(topicId: string, enabled: boolean): Promise<import("../../plugins/personal/topic/trigger.ts").TopicTrigger>;
  works(): readonly { id: string; topicId: string; revision: number; kind: "task" | "routine" }[];
  event(input: Omit<Incoming, "channelId" | "source"> & { name: string }): Promise<number>;
  work(topicId: string): { delete(id: string, revision: number): Promise<void> };
}
