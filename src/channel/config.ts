import { z } from "zod";

/** A named instance identifies the sending bot; Me is an optional human identity in that app's scope. */
export const LarkChannelConfigSchema = z.object({
  kind: z.literal("lark"), label: z.string().trim().min(1).max(100), enabled: z.boolean().default(true),
  appId: z.string().regex(/^cli_[a-zA-Z0-9]+$/), appSecret: z.string().min(1).max(1000),
  me: z.object({ openId: z.string().regex(/^ou_[a-zA-Z0-9]+$/) }).strict().optional(),
}).strict();
export type LarkChannelConfig = z.infer<typeof LarkChannelConfigSchema>;
export const ChannelsConfigSchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/), LarkChannelConfigSchema)
  .default({}).superRefine((channels, ctx) => {
    const apps = new Set<string>();
    for (const [id, channel] of Object.entries(channels)) {
      if (id === "web") ctx.addIssue({ code: "custom", path: [id], message: "web is the built-in Channel" });
      if (apps.has(channel.appId)) ctx.addIssue({ code: "custom", path: [id, "appId"], message: "Each Lark app belongs to one Channel instance" });
      apps.add(channel.appId);
    }
  });
export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;
export const enabledLarkApps = (channels: ChannelsConfig) => Object.values(channels).filter(c => c.enabled).map(c => c.appId);
