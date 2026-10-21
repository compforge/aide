import { Persons } from "../../person/service.ts";
import { LOCAL_ME } from "../../person/model.ts";
import { observePeople } from "../../person/messages.ts";
import { bindSourceInput, type SourceInput } from "@compforge/aide-plugin";
import { SOURCES } from "../definition.ts";
import type { ChatMessage, ConnectorClient, MessagePage, PluginContext, Resource } from "@compforge/aide-plugin";
import { INPUT_TYPE, digest } from "../../chief-model.ts";
import { type MessageKind, type MessageWatch } from "./config.ts";
import { boundContext, readMessageContext, type MessageContext } from "./context.ts";
import { messageRelation } from "./relation.ts";

export const MESSAGE_SOURCE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "MessageSource" } as const;
interface Scan {
  kind: MessageKind;
  watermark?: string;
  window?: { start: string; end: string; token?: string;
    page?: { ids: string[]; hasMore: boolean; nextToken?: string } };
}
interface Delivery {
  name: string;
  spec: SourceInput & { sessionId: string };
  known: string[];
  related: string[];
}
interface PendingMessage {
  message: ChatMessage;
  kind: MessageKind;
  discoveredAt: string;
  followUntil: string;
  sequence: number;
  known: string[];
  related: string[];
  finished?: boolean;
  delivery?: Delivery | null;
  follow?: { end: string; token?: string } | null;
}
export interface MessageSourceStatus {
  scans?: Scan[];
  pending?: PendingMessage[];
  lastObservedAt?: string;
  error?: string | null;
}
type Context = Pick<PluginContext, "resources" | "logger">;
type Source = Resource<MessageWatch, MessageSourceStatus>;
const iso = (ms: number) => new Date(ms).toISOString();
const inputName = (watch: MessageWatch, id: string, sequence: number) =>
  digest(["lark", watch.accountId, watch.userId, id, sequence]);
const inputRef = (name: string) => ({ ...INPUT_TYPE, namespace: "aide-system" as const, name });

/**
 * @spec Persist discovery and delivery plans before side effects. Advance a scan only after its Inputs exist.
 * @spec A restarted delivery reuses its exact Input and next observation state, never a fresh live snapshot.
 * @spec An observed original message is sufficient: absent context never delays its Input.
 * @spec Only retrieved context accompanies an Input; read failures stay in logs and never create discussion Inputs.
 * @spec Initial and discussion Inputs share source:lark:<appId>:<userId>:<chatId> affinity, separate from bot Channel conversations.
 * @why User observations must not enter the bot chat history or its automatic outbound delivery.
 * @why IM context is evidence from other people, not a delegation from the account owner.
 * @case tests/message-source.test.ts
 * @link docs/connector/lark-messages.md
 */
class MessageObservation {
  private readonly submitInput: ReturnType<typeof bindSourceInput>;
  constructor(private readonly context: Context, private resource: Source, private readonly connectors: ConnectorClient, private readonly now: number) {
    this.submitInput = bindSourceInput(SOURCES.lark, resource, context.resources);
  }
  private personIds?: string[];
  private get watch() { return { ...this.resource.spec, personIds: this.personIds ?? this.resource.spec.personIds }; }
  private get pending() { return this.resource.status.pending ?? []; }
  private get scans() { return this.resource.status.scans ?? []; }

  private async save(patch: Partial<MessageSourceStatus>) {
    // A connector verb can yield. Pin the incarnation before committing its result.
    const latest = await this.context.resources.get<MessageWatch, MessageSourceStatus>({ ...MESSAGE_SOURCE_TYPE, ...this.resource.metadata });
    if (!latest || latest.metadata.deletionTimestamp || digest(latest.spec) !== digest(this.resource.spec)) {
      throw new Error("Message Source changed during observation");
    }
    this.resource = await this.context.resources.patchStatus(latest, patch);
  }

  private update(entry: PendingMessage) {
    return this.save({ pending: this.pending.map((item) => item.message.id === entry.message.id ? entry : item) });
  }

  async run() {
    const people = new Persons(this.context.resources, { identities: [LOCAL_ME] });
    const me = await people.me();
    if (me) this.personIds = me.spec.identities.filter((i) => i.provider === "lark" && i.scope === this.resource.spec.accountId).map((i) => i.id);
    const account = await this.connectors.messages.identity();
    if (account.accountId !== this.watch.accountId || account.userId !== this.watch.userId) {
      throw new Error("Message Source account differs from the connected user");
    }
    for (const entry of [...this.pending]) if (entry.delivery) await this.deliver(entry);
    const failures: string[] = [];
    for (const kind of ["direct", "mention"] as const) {
      try { await this.discover(kind); }
      catch (error) { failures.push(`${kind}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const saved of [...this.pending]) {
      const entry = this.pending.find((item) => item.message.id === saved.message.id)!;
      if (entry.finished) await this.remove(entry);
      else if (!entry.sequence) await this.initialize(entry);
      else if (entry.kind === "mention") await this.follow(entry);
    }
    for (const scan of [...this.scans]) await this.commitScan(scan);
    if (failures.length) throw new Error(`Lark discovery incomplete: ${failures.join("; ")}`);
    await this.save({ lastObservedAt: iso(this.now), error: null });
  }

  private async discover(kind: MessageKind) {
    let scan = this.scans.find((item) => item.kind === kind) ?? { kind };
    if (scan.window?.page) return;
    if (!scan.window) {
      scan = { ...scan, window: { start: iso(scan.watermark
        ? Date.parse(scan.watermark) - this.watch.overlapMs : this.now - this.watch.initialLookbackMs), end: iso(this.now) } };
      await this.save({ scans: [...this.scans.filter((item) => item.kind !== kind), scan] });
    }
    const window = scan.window!;
    const page = await this.connectors.messages.search({ start: window.start, end: window.end,
      ...(window.token ? { pageToken: window.token } : {}), limit: 10,
      chatType: kind === "direct" ? "p2p" : "group", ...(kind === "mention" && this.watch.personIds.length === 1 && this.watch.personIds.includes(this.watch.userId) ? { atMe: true } : {}) });
    const pending = [...this.pending]; const ids: string[] = [];
    for (const message of page.messages) {
      if (message.deleted || message.sender.type !== "user" ||
          (kind === "mention" && !message.mentions.some((id) => (this.watch.personIds.length ? this.watch.personIds : [this.watch.userId]).includes(id)))) continue;
      ids.push(message.id);
      if (pending.some((item) => item.message.id === message.id) ||
          await this.context.resources.get(inputRef(inputName(this.watch, message.id, 0)))) continue;
      pending.push({ message, kind, discoveredAt: iso(this.now), followUntil: iso(this.now + this.watch.followupMs),
        sequence: 0, known: [], related: [message.id] });
    }
    scan = { ...scan, window: { ...window, page: { ids, hasMore: page.hasMore, ...(page.nextToken ? { nextToken: page.nextToken } : {}) } } };
    await this.save({ pending, scans: this.scans.map((item) => item.kind === kind ? scan : item) });
    this.context.logger.info("Lark messages discovered", { attributes: { kind, matched: ids.length,
      observed: page.messages.length, hasMore: page.hasMore, start: window.start, end: window.end } });
  }

  private async commitScan(scan: Scan) {
    const page = scan.window?.page;
    if (!page || page.ids.some((id) => this.pending.some((entry) => entry.message.id === id && !entry.sequence))) return;
    if (page.hasMore && (!page.nextToken || page.nextToken === scan.window!.token)) {
      throw new Error("Lark discovery pagination did not advance; watermark retained");
    }
    const next: Scan = page.hasMore
      ? { kind: scan.kind, ...(scan.watermark ? { watermark: scan.watermark } : {}),
        window: { start: scan.window!.start, end: scan.window!.end, token: page.nextToken! } }
      : { kind: scan.kind, watermark: scan.window!.end };
    await this.save({ scans: this.scans.map((item) => item.kind === scan.kind ? next : item) });
  }

  private async initialize(entry: PendingMessage) {
    let context: MessageContext | undefined;
    try { context = await readMessageContext(this.connectors.messages, entry.message, this.watch, this.now, this.context.logger); }
    catch (error) {
      this.context.logger.warn("Lark message context unavailable; submitting original message", {
        attributes: { messageId: entry.message.id, chatId: entry.message.chatId,
          error: error instanceof Error ? error.message : String(error) } });
    }
    const messages = context?.messages ?? [];
    const known = [entry.message.id, ...messages.map((message) => message.id)];
    await this.plan(entry, context, known, this.related(entry, messages));
  }

  private related(entry: PendingMessage, messages: ChatMessage[]): string[] {
    const related = new Set(entry.related);
    // Resolve reply chains even when a page arrives in descending order.
    for (let pass = 0; pass < messages.length; pass++) {
      const size = related.size;
      for (const message of messages) {
        if (entry.message.threadId === message.threadId && Boolean(message.threadId) ||
            message.parentId && related.has(message.parentId) || message.rootId && related.has(message.rootId)) related.add(message.id);
      }
      if (related.size === size) break;
    }
    return [...related];
  }

  private async follow(entry: PendingMessage) {
    if (!this.watch.followupMs) { await this.remove(entry); return; }
    const follow = entry.follow ?? { end: iso(Math.min(this.now, Date.parse(entry.followUntil))) };
    if (!entry.follow) { entry = { ...entry, follow }; await this.update(entry); }
    let page: MessagePage;
    try {
      page = entry.message.threadId
        ? await this.connectors.messages.thread({ threadId: entry.message.threadId, pageToken: follow.token, order: "asc", limit: 50 })
        : await this.connectors.messages.history({ chatId: entry.message.chatId, start: entry.message.createdAt,
          end: follow.end, pageToken: follow.token, order: "asc", limit: 50 });
      if (page.hasMore && (!page.nextToken || page.nextToken === follow.token)) throw new Error("Lark follow-up pagination did not advance");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.context.logger.warn("Lark discussion follow-up failed", { attributes: {
        messageId: entry.message.id, chatId: entry.message.chatId, error: detail } });
      if (this.now >= Date.parse(entry.followUntil)) await this.remove(entry);
      return;
    }
    // Thread API cannot filter time. Ascending pages past the fixed cutoff finish this scan.
    const hasMore = page.hasMore && !(entry.message.threadId && page.messages.some((message) => Date.parse(message.createdAt) > Date.parse(follow.end)));
    const eligible = page.messages.filter((message) => !message.deleted && Date.parse(message.createdAt) <= Date.parse(follow.end));
    const related = this.related(entry, eligible);
    const fresh = eligible.filter((message) => related.includes(message.id) && !entry.known.includes(message.id)
      // Another explicit mention has its own discovered Input.
      && !(message.sender.id !== this.watch.userId && message.mentions.includes(this.watch.userId)));
    const known = [...new Set([...entry.known, ...eligible.filter((message) => related.includes(message.id)).map((message) => message.id)])];
    const finished = !hasMore && Date.parse(follow.end) >= Date.parse(entry.followUntil);
    const next = { ...entry, related, finished, follow: hasMore ? { ...follow, token: page.nextToken! } : null };
    if (fresh.length) {
      await this.plan(next, boundContext(fresh, follow.end, hasMore, this.watch.maxContextChars), known, related);
    } else await this.update({ ...next, known });
    if (finished && !fresh.length) {
      await this.remove(entry);
    }
  }

  private async plan(entry: PendingMessage, context: MessageContext | undefined, known: string[], related: string[]) {
    const name = inputName(this.watch, entry.message.id, entry.sequence);
    const evidence = [entry.message, ...(context?.messages ?? [])];
    const persons = new Persons(this.context.resources, { identities: this.watch.personIds.map((id) => ({ provider: "lark", scope: this.watch.accountId, id })) });
    const senders = await observePeople(persons, this.watch.accountId, evidence);
    const annotate = (message: ChatMessage) => ({ ...message, ...(senders.has(message.id) ? { person: senders.get(message.id) } : {}),
      relation: messageRelation(this.watch, message, entry.kind === "direct", evidence) });
    const message = { ...annotate(entry.message), content: entry.message.content.slice(0, this.watch.maxContextChars) };
    const annotatedContext = context && { ...context, messages: context.messages.map(annotate) };
    // A batch can mix my speech and other people's reactions. Its per-message relations remain authoritative.
    const relations = new Set(annotatedContext?.messages.map((item) => item.relation));
    const relation = entry.sequence ? (relations.size === 1 ? annotatedContext!.messages[0]!.relation : this.watch.personIds.includes(this.watch.userId) ? "observed" : undefined) : message.relation;
    const kind = entry.sequence ? "讨论进展" : entry.kind === "direct" ? "私聊" : "群内 @";
    const content = entry.sequence ? (context?.messages ?? []).map((item) => item.content).join("\n\n") : message.content;
    const spec: Delivery["spec"] = {
      ...(relation ? { relation } : {}),
      ...(!entry.sequence && senders.has(entry.message.id) ? { sender: senders.get(entry.message.id) } : {}),
      sessionId: `source:lark:${this.watch.accountId}:${this.watch.userId}:${message.chatId}`,
      text: `Lark ${kind}：${content}`.slice(0, 32_000),
      observation: { provider: "lark", accountId: this.watch.accountId, userId: this.watch.userId,
        kind: entry.sequence ? "discussion" : entry.kind, message, originalMessageId: message.id,
        originalInputId: inputName(this.watch, message.id, 0), ...(annotatedContext?.messages.length ? { context: annotatedContext } : {}),
        messageTruncated: message.content.length !== entry.message.content.length } };
    const planned = { ...entry, delivery: { name, spec, known, related } };
    await this.update(planned);
    await this.deliver(planned);
  }

  private async deliver(entry: PendingMessage) {
    const delivery = entry.delivery!;
    if (!await this.context.resources.get(inputRef(delivery.name))) {
      await this.submitInput(delivery.name, delivery.spec);
    }
    await this.update({ ...entry, sequence: entry.sequence + 1, known: delivery.known,
      related: delivery.related, delivery: null });
    this.context.logger.info("Lark observation Input committed", { attributes: {
      messageId: entry.message.id, inputId: delivery.name, sessionId: delivery.spec.sessionId,
      kind: String(delivery.spec.observation!.kind), relation: delivery.spec.relation ?? "unknown" } });
    if (entry.kind === "direct" || entry.finished) await this.remove(entry);
  }

  private async remove(entry: PendingMessage) {
    await this.save({ pending: this.pending.filter((item) => item.message.id !== entry.message.id) });
    this.context.logger.info("Lark message observation finished", { attributes: { messageId: entry.message.id, kind: entry.kind } });
  }
}

export async function observeMessages(context: Context, resource: Source, connectors: ConnectorClient, now = Date.now()): Promise<void> {
  await new MessageObservation(context, resource, connectors, now).run();
}

export function registerMessageSources(context: PluginContext): void {
  const watch = context.instance.config.messageSource as MessageWatch | undefined;
  if (!watch) return;
  context.controllers.register<MessageWatch, MessageSourceStatus>({ resourceType: MESSAGE_SOURCE_TYPE,
    sources: [{ type: "resource", sourceId: "configured-messages", async start(source) {
      await source.emit({ name: digest(watch), spec: watch });
    } }],
    async reconcile(execution, resource) {
      if (resource.metadata.deletionTimestamp || digest(resource.spec) !== digest(watch)) return;
      try { await observeMessages(context, resource, execution.verbs.connectors({ timeoutMs: 55_000 })); }
      catch (error) {
        context.logger.error("Lark message observation failed; discovery progress retained", { error });
        const current = await context.resources.get<MessageWatch, MessageSourceStatus>({ ...MESSAGE_SOURCE_TYPE, ...resource.metadata });
        if (current) await context.resources.patchStatus(current, { error: error instanceof Error ? error.message : String(error) });
      }
      return { requeueAfterMs: watch.intervalMs };
    },
  });
}

/** A pending delivery and its discussion root cannot expire before the Source advances. */
export const messageLifecycle: import("@compforge/aide-plugin").ResourceLifecycle = {
  resourceType: MESSAGE_SOURCE_TYPE, releasedAt: () => undefined,
  references: (resource) => (resource.status as MessageSourceStatus).pending?.flatMap((entry) => [
    `input:${inputName(resource.spec as MessageWatch, entry.message.id, 0)}`,
    ...(entry.delivery ? [`input:${entry.delivery.name}`] : []),
  ]) ?? [],
};
