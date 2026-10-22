import { larkAddress, larkEndpoint } from "./address.ts";
import { channelOutputs } from "./output.ts";
import type { OutputView } from "../output.ts";
import { CHANNELS, bindChannelInput } from "./definition.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { normalize } from "@larksuiteoapi/node-sdk";
import type { ChannelService } from "./service.ts";
import { IncomingSchema } from "./message.ts";
import { progressCard, cardPreviews, cardContent, cardThought, type LarkProgressReader, type LarkProgress } from "./lark-card.ts";
import type { LarkTransport } from "./lark-client.ts";

/** @why Lark can return null for permission-restricted user_id; SDK normalization expects absent IDs as undefined. */
const UserIdsSchema = z.object({ open_id: z.string().optional(),
  user_id: z.string().nullish().transform((value) => value ?? undefined), union_id: z.string().optional() });

const EventSchema = z.object({
  sender: z.object({ sender_type: z.string(),
    sender_id: UserIdsSchema.optional() }),
  message: z.object({ message_id: z.string().min(1), chat_id: z.string().min(1),
    chat_type: z.string(), message_type: z.string(), content: z.string(),
    mentions: z.array(z.object({ key: z.string().min(1), name: z.string().optional(),
      id: UserIdsSchema })).optional() }),
});
const CardSchema = z.object({ cardId: z.string(), sent: z.boolean(), sequence: z.number().int(),
  layout: z.number().default(0), previews: z.string().default(""),
  streaming: z.boolean(), think: z.string(), content: z.string(), signature: z.string() });
type Card = z.infer<typeof CardSchema>;
const NoticeSchema = z.object({ id: z.string(), conversationId: z.string(), at: z.string(), role: z.literal("aide"), text: z.string(), workId: z.null() });
type Notice = z.infer<typeof NoticeSchema>;
const StateSchema = z.object({
  cards: z.record(z.string(), CardSchema).default({}),
  pending: z.array(IncomingSchema.omit({ channelId: true })), received: z.array(z.string()),
  chats: z.array(z.string()), notices: z.array(NoticeSchema), delivered: z.array(z.string()),
});
type State = z.infer<typeof StateSchema>;

/**
 * @spec Persist inbound messages before acknowledging Lark; acknowledge outbound delivery only after send succeeds.
 * @spec Bot chat identity is lark:<appId>:<chatId>; user-observation Sources use independent topics.
 * @case tests/message-source.test.ts
 * @why Platform acknowledgement must not depend on business processing or model latency.
 * @see {@link ../../docs/channel/lark.md}
 */
export class LarkChannel {
  private readonly acceptInput: ReturnType<typeof bindChannelInput>;
  private readonly path: string;
  private readonly prefix: string;
  private state: State;
  private timer?: ReturnType<typeof setInterval>;
  private inbound?: Promise<void>;
  private outbound?: Promise<void>;
  private stopped = false;
  private retryAt = 0;
  private readonly cardRetry = new Map<string, number>();
  private readonly receiptRetry = new Map<string, number>();

  constructor(home: string, private readonly appId: string, private readonly aide: Pick<ChannelService, "receive" | "outputs" | "outputDelivered" | "outputSending" | "outputRetry">,
    private readonly transport: LarkTransport, private readonly log: Logger, private readonly progress?: LarkProgressReader) {
    this.acceptInput = bindChannelInput(CHANNELS.lark, (input) => aide.receive(input));
    this.prefix = `lark:${appId}:`;
    this.path = join(home, "channels", `lark-${createHash("sha256").update(appId).digest("hex").slice(0, 16)}.json`);
    this.state = existsSync(this.path) ? StateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")))
      : { cards: {}, pending: [], received: [], chats: [], notices: [], delivered: [] };
  }

  async start(): Promise<void> {
    this.timer = setInterval(() => {
      void this.dispatch().catch(() => this.log.error("Lark inbox processing failed"));
      void this.deliver().catch(() => this.log.error("Lark outbox persistence failed"));
    }, 1000);
    await this.transport.start((event) => this.receive(event));
    this.log.info("Lark channel started; connection state is reported separately");
  }

  /**
   * @spec Group input requires an exact mention of the authenticated bot; group and direct chats retain separate conversation IDs.
   * @link docs/channel/lark.md
   * @case tests/lark.test.ts
   */
  async receive(raw: unknown): Promise<void> {
    if (this.stopped) throw new Error("Lark channel is stopping");
    const parsed = EventSchema.safeParse(raw);
    if (!parsed.success) {
      this.log.warn({ issues: parsed.error.issues.map(({ path, code, message }) => ({ path, code, message })) },
        "Ignoring malformed Lark message event");
      return;
    }
    const { sender, message } = parsed.data;
    if (sender.sender_type !== "user") {
      this.log.debug({ messageId: message.message_id, senderType: sender.sender_type }, "Ignoring Lark non-user message");
      return;
    }
    if (message.chat_type !== "p2p" && message.chat_type !== "group") {
      this.log.debug({ messageId: message.message_id, chatType: message.chat_type }, "Ignoring unsupported Lark chat type");
      return;
    }
    const botIdentity = this.transport.botIdentity;
    if (message.chat_type === "group" && (!botIdentity || !message.mentions?.some((mention) => mention.id.open_id === botIdentity.openId))) {
      this.log.debug({ messageId: message.message_id, chatId: message.chat_id,
        reason: botIdentity ? "bot_not_mentioned" : "bot_identity_unavailable" }, "Ignoring unaddressed Lark group message");
      return;
    }
    const { message_id: id, chat_id: chatId } = message;
    if (this.state.received.includes(id)) return;
    const conversationId = this.prefix + chatId;
    let text: unknown;
    if (message.message_type === "text") {
      if (message.chat_type === "group") {
        const normalized = await normalize({ sender: { ...sender, sender_id: sender.sender_id ?? {} },
          message: { ...message, chat_type: "group" } }, { botIdentity: botIdentity!, stripBotMentions: true });
        text = normalized.content;
      } else {
        try { text = JSON.parse(message.content).text; } catch { /* Send a helpful response below. */ }
      }
    }
    // Group normalization yields; concurrent duplicate deliveries must still persist only once.
    if (this.stopped) throw new Error("Lark channel is stopping");
    if (this.state.received.includes(id)) return;
    const input = IncomingSchema.omit({ channelId: true }).safeParse({ id, sessionId: conversationId, text, source: larkAddress(this.appId, chatId),
      observation: { provider: "lark", accountId: this.appId, chatId, chatType: message.chat_type,
        sender: { type: sender.sender_type, ...(sender.sender_id?.open_id ? { id: sender.sender_id.open_id } : {}) },
        mentions: (message.mentions ?? []).flatMap((mention) => mention.id.open_id ? [mention.id.open_id] : []) } });
    this.save({ ...this.state,
      pending: input.success ? [...this.state.pending, input.data] : this.state.pending,
      notices: input.success ? this.state.notices : [...this.state.notices,
        this.notice(id, conversationId, "目前支持文字消息，请发送不超过 32000 字的非空文字；群内请 @Aide 后描述问题。")],
      received: [...this.state.received, id],
      chats: this.state.chats.includes(chatId) ? this.state.chats : [...this.state.chats, chatId],
    });
    this.log.info({ messageId: id, conversationId, chatType: message.chat_type, accepted: input.success }, "Lark message received");
  }

  dispatch(): Promise<void> {
    if (this.inbound) return this.inbound;
    if (this.stopped) return Promise.resolve();
    this.inbound = this.drainInbox().finally(() => { this.inbound = undefined; });
    return this.inbound;
  }

  private async drainInbox(): Promise<void> {
    while (!this.stopped && this.state.pending.length) {
      const input = this.state.pending[0]!;
      let failure: Notice | undefined;
      try {
        await this.acceptInput(input);
        this.log.info({ messageId: input.id, conversationId: input.sessionId }, "Lark input routed");
      } catch {
        if (this.stopped) return;
        failure = this.notice(input.id, input.sessionId, "这条请求处理失败。请查看网页中的事项状态，再发一条消息要求重试或继续。");
        this.log.error({ messageId: input.id, conversationId: input.sessionId }, "Lark input failed; explicit user retry required");
      }
      this.save({ ...this.state, pending: this.state.pending.slice(1),
        notices: failure ? [...this.state.notices, failure] : this.state.notices });
    }
  }

  deliver(): Promise<void> {
    if (this.outbound) return this.outbound;
    if (this.stopped || Date.now() < this.retryAt) return Promise.resolve();
    this.outbound = this.drainOutbox().finally(() => { this.outbound = undefined; });
    return this.outbound;
  }

  private async drainOutbox(): Promise<void> {
    if (this.transport.cards && this.progress) {
      for (const chatId of this.state.chats) {
        const conversationId = this.prefix + chatId;
        for (const view of this.progress(conversationId)) {
          if (this.stopped) return;
          if (Date.now() < (this.cardRetry.get(view.id) ?? 0)) continue;
          try { await this.updateCard(chatId, view); }
          catch {
            this.cardRetry.set(view.id, Date.now() + 10_000);
            this.log.warn({ inputId: view.id, conversationId }, "Lark progress update failed; final text delivery remains available. Check cardkit:card:write scope and network");
          }
        }
      }
    }
    const notices: OutputView[] = this.state.notices.map((n) => ({ ...n, conversationUid: "", target: larkAddress(this.appId, n.conversationId.slice(this.prefix.length)), status: { phase: "pending", attempts: 0 } }));
    const outputs = [...channelOutputs(this.aide), ...notices]
      .filter((o) => larkEndpoint(o.target)?.appId === this.appId)
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    for (const message of outputs) {
      if (message.status.phase === "delivered" || message.status.phase === "failed" || message.status.phase === "uncertain") continue;
      if (message.status.nextAttemptAt && Date.now() < Date.parse(message.status.nextAttemptAt)) continue;
      const endpoint = larkEndpoint(message.target);
      if (!endpoint) continue;
      const { chatId } = endpoint;
      await this.aide.outputSending?.(message.id);
      const parts = textParts(message.text);
      for (const [index, text] of parts.entries()) {
        if (this.stopped) return;
        const id = this.deliveryId(message.id, index);
        if (this.state.delivered.includes(id)) continue;
        try {
          await this.transport.send(chatId, text, id);
        } catch {
          this.retryAt = Date.now() + 10_000;
          await this.aide.outputRetry?.(message.id, "Lark send failed", new Date(this.retryAt).toISOString());
          this.log.warn({ messageId: message.id, part: index, conversationId: message.conversationId }, "Lark send failed; retrying in 10 seconds");
          return;
        }
        this.save({ ...this.state, delivered: [...this.state.delivered, id] });
        this.log.info({ messageId: message.id, part: index, conversationId: message.conversationId }, "Lark message delivered");
      }
      await this.acknowledge(message.conversationId, message.id);
    }
  }

  /** @spec Receipt failures retain retryable messages without blocking unrelated outbound delivery. */
  private async acknowledge(conversationId: string, messageId: string): Promise<void> {
    if (Date.now() < (this.receiptRetry.get(messageId) ?? 0)) return;
    try {
      await this.aide.outputDelivered?.(messageId);
      this.receiptRetry.delete(messageId);
    } catch (err) {
      this.receiptRetry.set(messageId, Date.now() + 10_000);
      this.log.warn({ err, conversationId, messageId }, "Lark delivery receipt failed; retrying independently in 10 seconds");
    }
  }

  /**
   * @spec Card operations share a persisted increasing sequence; only a finalized card acknowledges business Message delivery.
   * @link docs/channel/lark.md
   */
  private async updateCard(chatId: string, view: LarkProgress): Promise<void> {
    const transport = this.transport.cards!;
    const live = view.phase === "running" || view.phase === "queued";
    let card = this.state.cards[view.id];
    // Completed history without a live card uses the existing durable text outbox.
    if (!card && !live) return;
    if (!card) {
      card = { cardId: await transport.create(progressCard(view, live)), sent: false, sequence: 0,
        layout: 1, previews: JSON.stringify(cardPreviews(view)),
        streaming: live, think: cardThought(view), content: cardContent(view), signature: "" };
      this.saveCard(view.id, card);
    }
    if (!card.sent) {
      await transport.send(chatId, card.cardId, this.deliveryId(`card:${view.id}`, 0));
      card.sent = true; this.saveCard(view.id, card);
      this.log.info({ inputId: view.id, conversationId: this.prefix + chatId }, "Lark progress card delivered");
    }
    const signature = JSON.stringify(view);
    if (card.signature === signature) return;
    const operation = async (run: (sequence: number, id: string) => Promise<void>) => {
      card.sequence++; this.saveCard(view.id, card);
      await run(card.sequence, this.deliveryId(`card:${view.id}`, card.sequence));
    };
    if (card.streaming !== live) {
      await operation((sequence, id) => transport.settings(card.cardId, live, sequence, id));
      card.streaming = live; this.saveCard(view.id, card);
    }
    if (card.layout !== 1) {
      await operation((sequence, id) => transport.update(card.cardId, progressCard(view, live), sequence, id));
      card.layout = 1; card.think = cardThought(view); card.content = cardContent(view);
      card.previews = JSON.stringify(cardPreviews(view)); this.saveCard(view.id, card);
      this.log.info({ inputId: view.id, cardId: card.cardId }, "Lark card upgraded to stable reply panels");
    }
    const patches: Record<string, unknown> = {};
    for (const [field, elementId, text] of [["think", "think", cardThought(view)], ["content", "content", cardContent(view)]] as const) {
      if (card[field] === text) continue;
      if (live) {
        await operation((sequence, id) => transport.content(card.cardId, elementId, text, sequence, id));
        card[field] = text; this.saveCard(view.id, card);
      } else patches[elementId] = { content: text };
    }
    const previews = cardPreviews(view), previewSignature = JSON.stringify(previews);
    if (card.previews !== previewSignature) Object.assign(patches, previews);
    // Text-only patches never write expanded or replace panels, including at completion and resumption.
    if (Object.keys(patches).length) {
      await operation((sequence, id) => transport.patch(card.cardId, patches, sequence, id));
      card.think = cardThought(view); card.content = cardContent(view); card.previews = previewSignature;
      this.saveCard(view.id, card);
    }
    if (!live) {
      if (!view.overflow) {
        const receipts = view.messageIds.map((id) => this.deliveryId(id, 0));
        this.save({ ...this.state, delivered: [...new Set([...this.state.delivered, ...receipts])] });
        for (const id of view.messageIds) await this.acknowledge(this.prefix + chatId, id);
      }
      this.log.info({ inputId: view.id, phase: view.phase }, "Lark progress card settled");
    }
    card.signature = signature; this.saveCard(view.id, card);
  }

  private saveCard(id: string, card: Card): void {
    this.save({ ...this.state, cards: { ...this.state.cards, [id]: card } });
  }
  private deliveryId(messageId: string, part: number): string {
    return createHash("sha256").update(`${this.prefix}${messageId}:${part}`).digest("hex").slice(0, 32);
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.transport.close();
    await Promise.allSettled([this.inbound, this.outbound]);
  }

  private notice(id: string, conversationId: string, text: string): Notice {
    return { id: `notice:${id}`, conversationId, text, role: "aide", workId: null, at: new Date().toISOString() };
  }

  private save(next: State): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + ".tmp";
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.state = next;
  }
}

/** @why Keep encoded text well below Lark's 150 KB limit, including JSON escaping. */
function textParts(text: string): string[] {
  const points = Array.from(text || "（空消息）");
  const result: string[] = [];
  for (let offset = 0; offset < points.length; offset += 4000) result.push(points.slice(offset, offset + 4000).join(""));
  return result;
}
