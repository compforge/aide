import { z } from "zod";
import { createHash } from "node:crypto";
import type { SessionHandle } from "./store/store.ts";
interface ActivityView {
  get(id: string): unknown;
  list(): Array<{ id: string }>;
  inputs(): Array<{ status: { phase?: string } }>;
}

export const HeartbeatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  intervalSeconds: z.number().int().positive().max(2_147_483).default(3600),
}).strict();
export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;
export interface HeartbeatState { conversationId: string; nextAt: string }

/**
 * @spec The switch gates new Inputs only. Disabling never cancels queued input or delegated work.
 * @spec One persisted deadline and destination per Session; downtime coalesces into one check, not a backlog.
 * @link docs/plugin/personal.md
 */
export class SessionHeartbeat {
  constructor(private readonly session: SessionHandle, private readonly conversations: ActivityView,
    private readonly submit: (inputId: string, conversationId: string) => void | Promise<void>) {}

  get config(): HeartbeatConfig { return HeartbeatConfigSchema.parse(this.session.meta.heartbeat ?? {}); }

  setEnabled(enabled: boolean, conversationId: string, now = new Date()): HeartbeatConfig {
    if (!this.conversations.get(conversationId)) throw new Error("Heartbeat conversation does not exist in this Session");
    const config = this.config;
    if (config.enabled === enabled) return config;
    const heartbeat = { ...config, enabled };
    // Retain an established destination when toggled from another view of the same Session.
    const destination = this.session.meta.heartbeatState?.conversationId ?? conversationId;
    this.session.updateMeta({ heartbeat, heartbeatState: { conversationId: destination,
      nextAt: new Date(now.getTime() + heartbeat.intervalSeconds * 1000).toISOString() } });
    return heartbeat;
  }

  async tick(now = new Date()): Promise<void> {
    const config = this.config;
    if (!config.enabled) return;
    const state = this.session.meta.heartbeatState;
    const nextAt = new Date(now.getTime() + config.intervalSeconds * 1000).toISOString();
    if (!state) {
      const conversation = this.conversations.list()[0];
      if (conversation) this.session.updateMeta({ heartbeatState: { conversationId: conversation.id, nextAt } });
      return;
    }
    if (Date.parse(state.nextAt) > now.getTime()) return;
    // Pending user decisions or active/queued inputs must not accumulate scheduled work behind them.
    const busy = this.conversations.inputs().some((input) => !input.status.phase || input.status.phase === "running" || input.status.phase === "waiting");
    if (!busy) {
      const id = "heartbeat:" + createHash("sha256").update(JSON.stringify([this.session.id, state.nextAt])).digest("hex");
      await this.submit(id, state.conversationId);
    }
    // Commit the Input first. If the host exits here, its stable ID deduplicates the same deadline.
    this.session.updateMeta({ heartbeatState: { ...state, nextAt } });
  }
}
