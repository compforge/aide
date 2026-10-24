import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { Logger } from "pino";
import { ConfigSchema, type AideConfig } from "../config.ts";
import { LarkChannelConfigSchema } from "./config.ts";

export class ChannelSettingsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export const ChannelSettingsChangeSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("save"), revision: z.string(), id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
    channel: LarkChannelConfigSchema.extend({ appSecret: z.string().min(1).max(1000).optional() }) }).strict(),
  z.object({ operation: z.literal("default"), revision: z.string(), id: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("remove"), revision: z.string(), id: z.string().min(1) }).strict(),
]);
export type ChannelSettingsChange = z.infer<typeof ChannelSettingsChangeSchema>;
const revision = (text: string) => createHash("sha256").update(text).digest("hex");

/** @spec Configuration edits persist the next startup snapshot, never pretend to reload running transports.
 * @spec Secrets are write-only; omission retains an existing secret only for the same app. YAML edits preserve unrelated configuration.
 * @link docs/configuration.md
 */
export class ChannelSettings {
  constructor(private readonly path: string, private readonly active: AideConfig, private readonly log: Logger) {}
  private read() {
    let text: string;
    try { text = readFileSync(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; text = ""; }
    const document = parseDocument(text || "{}\n");
    const result = document.errors.length ? undefined : ConfigSchema.safeParse(document.toJS() ?? {});
    if (!result?.success) throw new ChannelSettingsError(409, "配置文件无法解析，请先修正 config.yaml。");
    return { document, config: result.data, revision: revision(text) };
  }
  snapshot() {
    const { config, revision } = this.read();
    return { revision, defaultChannel: config.defaultChannel, activeDefaultChannel: this.active.defaultChannel,
      restartRequired: config.defaultChannel !== this.active.defaultChannel || !isDeepStrictEqual(config.channels, this.active.channels),
      channels: Object.entries(config.channels).map(([id, { appSecret, ...channel }]) => ({ id, ...channel,
        secretConfigured: Boolean(appSecret), active: Boolean(this.active.channels[id]?.enabled),
        changed: !isDeepStrictEqual(config.channels[id], this.active.channels[id]) })),
    };
  }
  change(input: ChannelSettingsChange) {
    const saved = this.read();
    if (input.revision !== saved.revision) throw new ChannelSettingsError(409, "配置已更新，请刷新后再修改。");
    if (input.operation === "save") {
      if (input.id === "web") throw new ChannelSettingsError(400, "Web 是内置渠道，不能覆盖。");
      const previous = saved.config.channels[input.id];
      const appSecret = input.channel.appSecret ?? (previous?.appId === input.channel.appId ? previous.appSecret : undefined);
      if (!appSecret) throw new ChannelSettingsError(400, "新增或更换应用时，请填写 App Secret。");
      saved.document.setIn(["channels", input.id], { ...input.channel, appSecret });
    } else if (input.operation === "default") saved.document.set("defaultChannel", input.id);
    else {
      if (input.id === "web") throw new ChannelSettingsError(400, "Web 是内置渠道，不能删除。");
      saved.document.deleteIn(["channels", input.id]);
    }
    const parsed = ConfigSchema.safeParse(saved.document.toJS());
    if (!parsed.success) {
      const fields = parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw new ChannelSettingsError(400, `配置无效：${fields}`);
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, saved.document.toString(), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    this.log.info({ operation: input.operation, channelId: input.id }, "Channel configuration saved; restart required to apply");
    return this.snapshot();
  }
}
export type ChannelSettingsView = ReturnType<ChannelSettings["snapshot"]>;
