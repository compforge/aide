import { execFile } from "node:child_process";
import { z } from "zod";
import type { ChatMessage, MessageConnector, MessagePage, MessageQuery, MessageSearchQuery } from "@compforge/aide-plugin";
import type { LarkMessagesConfig } from "./config.ts";

export type LarkCliRunner = (args: readonly string[]) => Promise<unknown>;

/** CLI stderr may contain account details; surface structured codes/scopes, never raw output. */
export function larkFailure(value: unknown): Error {
  const parsed = z.object({ error: z.object({ type: z.string().optional(), subtype: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional(), missing_scopes: z.array(z.string()).optional() }) }).safeParse(value);
  if (!parsed.success) return new Error("Lark CLI failed; check user authorization and connectivity");
  const error = parsed.data.error;
  return new Error(`Lark read failed (${[error.type, error.subtype, error.code].filter((x) => x !== undefined).join("/")})` +
    (error.missing_scopes?.length ? `; required scopes: ${error.missing_scopes.join(", ")}` : ""));
}

export function larkCliRunner(timeoutMs: number): LarkCliRunner {
  return (args) => new Promise((resolve, reject) => {
    execFile("lark-cli", [...args], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TZ: "UTC", LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" } },
    (error, stdout, stderr) => {
      if (error) {
        if (error.code === "ENOENT") return reject(new Error("Lark reads require lark-cli on the service PATH"));
        if (error.killed) return reject(new Error(`Lark CLI exceeded ${timeoutMs}ms timeout`));
        try { reject(larkFailure(JSON.parse(stderr))); } catch { reject(larkFailure(null)); }
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Lark CLI returned invalid JSON")); }
    });
  });
}

const MessageSchema = z.object({
  message_id: z.string().min(1), chat_id: z.string().min(1), chat_name: z.string().nullish(), content: z.string(),
  create_time: z.string(), update_time: z.string().optional(), deleted: z.boolean(),
  sender: z.object({ id: z.string(), sender_type: z.string(), name: z.string().optional() }),
  mentions: z.array(z.object({ id: z.string() })).default([]),
  thread_id: z.string().optional(), reply_to: z.string().optional(), root_id: z.string().optional(),
  thread_message_position: z.string().optional(),
  message_app_link: z.string().optional(),
});

/** CLI compact timestamps have minute precision; the runner fixes TZ so host timezone cannot shift windows. */
function timestamp(value: string): string {
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(value) ? `${value.replace(" ", "T")}:00Z` : value;
  const ms = /^\d{13}$/.test(value) ? Number(value) : Date.parse(normalized);
  if (!Number.isFinite(ms) || (!normalized.endsWith("Z") && !/[+-]\d\d:\d\d$/.test(normalized) && !/^\d{13}$/.test(value))) {
    throw new Error("Lark CLI returned an unsupported message timestamp");
  }
  return new Date(ms).toISOString();
}

function message(value: unknown): ChatMessage {
  const parsed = MessageSchema.safeParse(value);
  if (!parsed.success) throw new Error("Lark CLI returned an incomplete message; discovery watermark retained");
  const row = parsed.data;
  return { id: row.message_id, chatId: row.chat_id, ...(row.chat_name?.trim() ? { chatName: row.chat_name.trim() } : {}), content: row.content, createdAt: timestamp(row.create_time),
    ...(row.update_time ? { updatedAt: timestamp(row.update_time) } : {}),
    sender: { id: row.sender.id, type: row.sender.sender_type, ...(row.sender.name ? { name: row.sender.name } : {}) },
    mentions: row.mentions.map((item) => item.id), deleted: row.deleted,
    ...(row.thread_id ? { threadId: row.thread_id } : {}), ...(row.reply_to ? { parentId: row.reply_to } : {}),
    ...(row.thread_message_position ? { threadPosition: row.thread_message_position } : {}),
    ...(row.root_id ? { rootId: row.root_id } : {}), ...(row.message_app_link ? { url: row.message_app_link } : {}) };
}

const QuerySchema = z.object({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }),
  pageToken: z.string().min(1).optional(), limit: z.number().int().min(1).max(50).default(50) })
  .refine((query) => Date.parse(query.start) <= Date.parse(query.end), "Message start must precede end");
const PageSchema = z.object({ ok: z.literal(true), identity: z.literal("user"),
  data: z.object({ messages: z.array(z.unknown()), has_more: z.boolean(), page_token: z.string().optional() }) });
/** Search forwards time_range literally; its API requires second precision with an explicit offset. */
const cliTime = (value: string) => new Date(value).toISOString().replace(/\.\d{3}Z$/, "+00:00");

/**
 * @spec Reads only as the configured user; each request is one explicit page with bounded process output.
 * @why Search includes @all. Exact personal mention selection belongs to the Personal Source.
 * @case tests/lark-messages.test.ts
 * @link docs/connector/lark-messages.md
 */
export class LarkMessages implements MessageConnector {
  private running = 0;
  constructor(readonly config: LarkMessagesConfig, private readonly run: LarkCliRunner = larkCliRunner(config.timeoutMs)) {}

  async identity() {
    const value = await this.run(["auth", "status", "--json"]);
    const parsed = z.object({ appId: z.string(), identities: z.object({ user: z.object({
      available: z.literal(true), openId: z.string(),
    }) }) }).safeParse(value);
    if (!parsed.success) throw new Error("Lark user login is unavailable; authorize lark-cli as the configured user");
    if (parsed.data.appId !== this.config.appId || parsed.data.identities.user.openId !== this.config.userId) {
      throw new Error("Lark CLI login does not match configured appId/userId; reads stopped");
    }
    return { accountId: this.config.appId, userId: this.config.userId };
  }

  search(query: MessageSearchQuery): Promise<MessagePage> {
    const input = QuerySchema.parse(query);
    const chatType = z.enum(["p2p", "group"]).optional().parse(query.chatType);
    const senderIds = z.array(z.string().regex(/^ou_[a-zA-Z0-9]+$/)).min(1).optional().parse(query.senderIds);
    return this.read(["im", "+messages-search", ...(query.atMe ? ["--is-at-me"] : []),
      ...(chatType ? ["--chat-type", chatType] : []), ...(senderIds ? ["--sender", senderIds.join(",")] : []), "--sender-type", "user",
      "--start", cliTime(input.start), "--end", cliTime(input.end), ...this.pagination(input)], input.end);
  }

  history(query: MessageQuery & { chatId: string; order?: "asc" | "desc" }): Promise<MessagePage> {
    const input = QuerySchema.parse(query);
    const chatId = z.string().regex(/^oc_[a-zA-Z0-9]+$/).parse(query.chatId);
    const order = z.enum(["asc", "desc"]).parse(query.order ?? "asc");
    return this.read(["im", "+chat-messages-list", "--chat-id", chatId, "--start", cliTime(input.start),
      "--end", cliTime(input.end), "--order", order, ...this.pagination(input)], input.end);
  }

  thread(query: { threadId: string; pageToken?: string; limit?: number; order?: "asc" | "desc" }): Promise<MessagePage> {
    const input = z.object({ threadId: z.string().regex(/^om[t]?_[a-zA-Z0-9]+$/),
      pageToken: z.string().min(1).optional(), limit: z.number().int().min(1).max(50).default(50),
      order: z.enum(["asc", "desc"]).default("asc") }).parse(query);
    return this.read(["im", "+threads-messages-list", "--thread", input.threadId, "--order", input.order,
      ...this.pagination(input)], new Date().toISOString());
  }

  private pagination(query: { pageToken?: string; limit: number }): string[] {
    return ["--page-size", String(query.limit), ...(query.pageToken ? ["--page-token", query.pageToken] : [])];
  }

  private async read(args: string[], observedThrough: string): Promise<MessagePage> {
    if (this.running >= 2) throw new Error("Lark read concurrency limit reached; retry later");
    this.running++;
    try {
      await this.identity();
      const value = await this.run([...args, "--as", "user", "--no-reactions", "--format", "json"]);
      const parsed = PageSchema.safeParse(value);
      if (!parsed.success) throw larkFailure(value);
      const { messages, has_more, page_token } = parsed.data.data;
      if (has_more && !page_token) throw new Error("Lark CLI omitted a required continuation token");
      // Embedded thread previews are not complete pages. Follow explicit thread_id through thread().
      return { messages: messages.map(message), hasMore: has_more,
        ...(has_more ? { nextToken: page_token! } : {}), observedThrough };
    } finally { this.running--; }
  }
}
