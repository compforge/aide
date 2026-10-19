import type { ChannelService } from "../channel/service.ts";
import type { Incoming } from "../channel/message.ts";

/** Product-specific sidebar and external event input supplied by application composition. */
export interface WebService extends ChannelService {
  setHeartbeat(sessionId: string, conversationId: string, enabled: boolean): import("../host/heartbeat.ts").HeartbeatConfig;
  works(): readonly { id: string; conversationId: string; revision: number }[];
  event(input: Incoming & { name: string }): Promise<number>;
  work(conversationId: string): { delete(id: string, revision: number): Promise<void> };
}
