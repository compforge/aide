import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { Aide } from "../../plugins/personal/aide.ts";
import { IncomingSchema, MessageSchema, type Message } from "../../plugins/personal/model.ts";
import { progressCard, cardContent, cardThought, type FeishuProgressReader, type FeishuProgress } from "./feishu-card.ts";
import type { FeishuTransport } from "./feishu-client.ts";

const EventSchema = z.object({
  sender: z.object({ sender_type: z.string() }),
  message: z.object({ message_id: z.string().min(1), chat_id: z.string().min(1),
    chat_type: z.string(), message_type: z.string(), content: z.string() }),
});
const CardSchema = z.object({ cardId: z.string(), sent: z.boolean(), sequence: z.number().int(),
  streaming: z.boolean(), think: z.string(), content: z.string(), signature: z.string() });
type Card = z.infer<typeof CardSchema>;
const StateSchema = z.object({
  cards: z.record(z.string(), CardSchema).default({}),
  pending: z.array(IncomingSchema), received: z.array(z.string()),
  chats: z.array(z.string()), notices: z.array(MessageSchema), delivered: z.array(z.string()),
});
type State = z.infer<typeof StateSchema>;

/**
 * @spec Persist inbound messages before acknowledging Feishu; acknowledge outbound delivery only after send succeeds.
 * @why Platform acknowledgement must not depend on business processing or model latency.
 * @see {@link ../../docs/channel/feishu.md}
 */
export class FeishuChannel {
  private readonly path: string;
  private readonly prefix: string;
  private state: State;
  private timer?: ReturnType<typeof setInterval>;
  private inbound?: Promise<void>;
  private outbound?: Promise<void>;
  private stopped = false;
  private retryAt = 0;
  private readonly cardRetry = new Map<string, number>();

  constructor(home: string, appId: string, private readonly aide: Pick<Aide, "receive" | "messages">,
    private readonly transport: FeishuTransport, private readonly log: Logger, private readonly progress?: FeishuProgressReader) {
    this.prefix = `feishu:${appId}:`;
    this.path = join(home, "channels", `feishu-${createHash("sha256").update(appId).digest("hex").slice(0, 16)}.json`);
    this.state = existsSync(this.path) ? StateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")))
      : { cards: {}, pending: [], received: [], chats: [], notices: [], delivered: [] };
  }

  async start(): Promise<void> {
    this.timer = setInterval(() => {
      void this.dispatch().catch(() => this.log.error("Feishu inbox processing failed"));
      void this.deliver().catch(() => this.log.error("Feishu outbox persistence failed"));
    }, 1000);
    await this.transport.start((event) => this.receive(event));
    this.log.info("Feishu channel started; connection state is reported separately");
  }

  receive(raw: unknown): void {
    if (this.stopped) throw new Error("Feishu channel is stopping");
    const parsed = EventSchema.safeParse(raw);
    if (!parsed.success) { this.log.warn("Ignoring malformed Feishu message event"); return; }
    const { sender, message } = parsed.data;
    if (sender.sender_type !== "user" || message.chat_type !== "p2p") return;
    const { message_id: id, chat_id: chatId } = message;
    if (this.state.received.includes(id)) return;
    const conversationId = this.prefix + chatId;
    let text: unknown;
    if (message.message_type === "text") {
      try { text = JSON.parse(message.content).text; } catch { /* Send a helpful response below. */ }
    }
    const input = IncomingSchema.safeParse({ id, conversationId, text });
    this.save({ ...this.state,
      pending: input.success ? [...this.state.pending, input.data] : this.state.pending,
      notices: input.success ? this.state.notices : [...this.state.notices,
        this.notice(id, conversationId, "目前支持单聊文字消息，请发送不超过 32000 字的文字。")],
      received: [...this.state.received, id],
      chats: this.state.chats.includes(chatId) ? this.state.chats : [...this.state.chats, chatId],
    });
    this.log.info({ messageId: id, conversationId, accepted: input.success }, "Feishu message received");
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
      let failure: Message | undefined;
      try {
        await this.aide.receive(input);
        this.log.info({ messageId: input.id, conversationId: input.conversationId }, "Feishu input routed");
      } catch {
        if (this.stopped) return;
        failure = this.notice(input.id, input.conversationId, "这条请求处理失败。请查看网页中的事项状态，再发一条消息要求重试或继续。");
        this.log.error({ messageId: input.id, conversationId: input.conversationId }, "Feishu input failed; explicit user retry required");
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
            this.log.warn({ inputId: view.id, conversationId }, "Feishu progress update failed; final text delivery remains available. Check cardkit:card:write scope and network");
          }
        }
      }
    }
    const messages = [...this.aide.messages(), ...this.state.notices]
      .filter((message) => message.role === "aide" && message.conversationId.startsWith(this.prefix))
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    for (const message of messages) {
      const chatId = message.conversationId.slice(this.prefix.length);
      if (!this.state.chats.includes(chatId)) continue;
      const parts = textParts(message.text);
      for (const [index, text] of parts.entries()) {
        if (this.stopped) return;
        const id = this.deliveryId(message.id, index);
        if (this.state.delivered.includes(id)) continue;
        try {
          await this.transport.send(chatId, text, id);
        } catch {
          this.retryAt = Date.now() + 10_000;
          this.log.warn({ messageId: message.id, part: index, conversationId: message.conversationId }, "Feishu send failed; retrying in 10 seconds");
          return;
        }
        this.save({ ...this.state, delivered: [...this.state.delivered, id] });
        this.log.info({ messageId: message.id, part: index, conversationId: message.conversationId }, "Feishu message delivered");
      }
    }
  }

  /**
   * @spec Card operations share a persisted increasing sequence; only a finalized card acknowledges business Message delivery.
   * @link docs/channel/feishu.md
   */
  private async updateCard(chatId: string, view: FeishuProgress): Promise<void> {
    const transport = this.transport.cards!;
    const live = view.phase === "running" || view.phase === "queued";
    let card = this.state.cards[view.id];
    // Completed history without a live card uses the existing durable text outbox.
    if (!card && !live && view.phase !== "waiting") return;
    if (!card) {
      const initial = { ...view, content: "", think: "", overflow: false };
      card = { cardId: await transport.create(progressCard(initial, true)), sent: false, sequence: 0,
        streaming: true, think: cardThought(initial), content: cardContent(initial), signature: "" };
      this.saveCard(view.id, card);
    }
    if (!card.sent) {
      await transport.send(chatId, card.cardId, this.deliveryId(`card:${view.id}`, 0));
      card.sent = true; this.saveCard(view.id, card);
      this.log.info({ inputId: view.id, conversationId: this.prefix + chatId }, "Feishu progress card delivered");
    }
    const signature = JSON.stringify(view);
    if (card.signature === signature) return;
    const operation = async (run: (sequence: number, id: string) => Promise<void>) => {
      card.sequence++; this.saveCard(view.id, card);
      await run(card.sequence, this.deliveryId(`card:${view.id}`, card.sequence));
    };
    if (live) {
      if (!card.streaming) {
        await operation((sequence, id) => transport.settings(card.cardId, true, sequence, id));
        await operation((sequence, id) => transport.update(card.cardId, progressCard(view, true), sequence, id));
        card.streaming = true; card.think = cardThought(view); card.content = cardContent(view);
      } else {
        if (card.think !== cardThought(view)) {
          await operation((sequence, id) => transport.content(card.cardId, "think", cardThought(view), sequence, id));
          card.think = cardThought(view); this.saveCard(view.id, card);
        }
        if (card.content !== cardContent(view)) {
          await operation((sequence, id) => transport.content(card.cardId, "content", cardContent(view), sequence, id));
          card.content = cardContent(view); this.saveCard(view.id, card);
        }
      }
    } else {
      if (card.streaming) {
        await operation((sequence, id) => transport.settings(card.cardId, false, sequence, id));
        card.streaming = false; this.saveCard(view.id, card);
      }
      await operation((sequence, id) => transport.update(card.cardId, progressCard(view, false), sequence, id));
      if (!view.overflow) {
        const receipts = view.messageIds.map((id) => this.deliveryId(id, 0));
        this.save({ ...this.state, delivered: [...new Set([...this.state.delivered, ...receipts])] });
      }
      this.log.info({ inputId: view.id, phase: view.phase }, "Feishu progress card settled");
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

  private notice(id: string, conversationId: string, text: string): Message {
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

/** @why Keep encoded text well below Feishu's 150 KB limit, including JSON escaping. */
function textParts(text: Message["text"]): string[] {
  const points = Array.from(text || "（空消息）");
  const result: string[] = [];
  for (let offset = 0; offset < points.length; offset += 4000) result.push(points.slice(offset, offset + 4000).join(""));
  return result;
}
