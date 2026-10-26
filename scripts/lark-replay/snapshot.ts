import { z } from "zod";
import type { ChatMessage, MessageConnector, MessagePage, MessageQuery, MessageSearchQuery } from "@compforge/aide-plugin";

const time = z.iso.datetime({ offset: true });
const message = z.object({
  id: z.string(), chatId: z.string(), chatName: z.string().optional(), threadId: z.string().optional(), parentId: z.string().optional(),
  rootId: z.string().optional(), threadPosition: z.string().optional(),
  sender: z.object({ id: z.string(), type: z.string(), name: z.string().optional() }),
  content: z.string(), createdAt: time, updatedAt: time.optional(), mentions: z.array(z.string()),
  deleted: z.boolean(), url: z.string().optional(),
});
export const SnapshotSchema = z.object({
  version: z.literal(1), collectedAt: time, start: time, end: time,
  identity: z.object({ accountId: z.string(), userId: z.string() }), meIds: z.array(z.string()).min(1),
  messages: z.array(message), directIds: z.array(z.string()), groupIds: z.array(z.string()),
  coverage: z.array(z.object({ operation: z.enum(["direct", "group", "sent", "history", "thread"]), key: z.string(),
    start: time, end: time, complete: z.boolean(), pages: z.number(), error: z.string().optional() })),
}).superRefine((s, context) => {
  if (Date.parse(s.start) >= Date.parse(s.end)) context.addIssue({ code: "custom", message: "Snapshot start must precede end" });
  const ids = new Set(s.messages.map(m => m.id));
  if (ids.size !== s.messages.length || [...s.directIds, ...s.groupIds].some(id => !ids.has(id))) {
    context.addIssue({ code: "custom", message: "Snapshot has duplicate messages or missing discovery messages" });
  }
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const edited = (m: ChatMessage) => !!m.updatedAt && Date.parse(m.updatedAt) > Date.parse(m.createdAt);

/** @spec Frozen reads never reveal future messages or reconstruct unavailable pre-edit content.
 * @spec Search membership comes from recorded search results, not chat history or guessed chat types.
 * @link docs/e2e-lark-replay.md
 */
export class SnapshotMessages implements MessageConnector {
  private cutoff: number;
  private readonly direct: Set<string>;
  private readonly group: Set<string>;
  private coverageFailure?: Error;
  constructor(readonly snapshot: Snapshot) {
    this.cutoff = Date.parse(snapshot.start);
    this.direct = new Set(snapshot.directIds); this.group = new Set(snapshot.groupIds);
  }
  advance(at: string) {
    const next = Date.parse(at);
    if (!Number.isFinite(next) || next < this.cutoff || next > Date.parse(this.snapshot.end)) throw new Error("Replay cutoff must advance within the snapshot");
    this.cutoff = next;
  }
  async identity() { return this.snapshot.identity; }
  private visible() {
    return this.snapshot.messages.filter(m => Date.parse(m.createdAt) <= this.cutoff && !edited(m));
  }
  /** @spec A Source may catch connector errors; replay must still fail rather than report missing discussions as completed.
   * @link docs/e2e-lark-replay.md
   * @case tests/lark-replay.test.ts
   */
  assertCoverage() {
    if (this.coverageFailure) throw this.coverageFailure;
  }
  private requireCoverage(operation: Snapshot["coverage"][number]["operation"], key: string, start: number, end: number) {
    const ranges = this.snapshot.coverage.filter(c => c.operation === operation && c.key === key && c.complete)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    let through = start;
    for (const range of ranges) {
      if (Date.parse(range.start) > through) break;
      through = Math.max(through, Date.parse(range.end));
      if (through >= end) return;
    }
    this.coverageFailure ??= new Error(`Incomplete snapshot coverage: ${operation} ${key || "discovery"} ${new Date(start).toISOString()}..${new Date(end).toISOString()}; recollect before replay`);
    throw this.coverageFailure;
  }
  private page(rows: ChatMessage[], query: { pageToken?: string; limit?: number; order?: "asc" | "desc" }, through: number): MessagePage {
    const offset = Number(query.pageToken ?? 0), limit = query.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid snapshot page request");
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (query.order === "desc") rows.reverse();
    const next = offset + limit;
    return { messages: rows.slice(offset, next), hasMore: next < rows.length,
      ...(next < rows.length ? { nextToken: String(next) } : {}), observedThrough: new Date(through).toISOString() };
  }
  async search(query: MessageSearchQuery) {
    const start = Math.max(Date.parse(query.start), Date.parse(this.snapshot.start)), end = Math.min(Date.parse(query.end), this.cutoff);
    const kinds = query.chatType === "p2p" ? ["direct"] as const : query.chatType === "group" ? ["group"] as const : ["direct", "group"] as const;
    for (const kind of kinds) this.requireCoverage(kind === "group" && query.senderIds ? "sent" : kind, "", start, end);
    const rows = this.visible().filter(m => Date.parse(m.createdAt) >= start && Date.parse(m.createdAt) <= end
      && kinds.some(k => (k === "direct" ? this.direct : this.group).has(m.id))
      && (!query.atMe || m.mentions.includes(this.snapshot.identity.userId))
      && (!query.senderIds || query.senderIds.includes(m.sender.id)));
    return this.page(rows, query, end);
  }
  async history(query: MessageQuery & { chatId: string; order?: "asc" | "desc" }) {
    const start = Date.parse(query.start), end = Math.min(Date.parse(query.end), this.cutoff);
    this.requireCoverage("history", query.chatId, start, end);
    return this.page(this.visible().filter(m => m.chatId === query.chatId && Date.parse(m.createdAt) >= start && Date.parse(m.createdAt) <= end), query, end);
  }
  async thread(query: { threadId: string; pageToken?: string; limit?: number; order?: "asc" | "desc" }) {
    this.requireCoverage("thread", query.threadId, Date.parse(this.snapshot.start), this.cutoff);
    return this.page(this.visible().filter(m => m.threadId === query.threadId), query, this.cutoff);
  }
}

export function triggerMessages(snapshot: Snapshot) {
  const direct = new Set(snapshot.directIds), group = new Set(snapshot.groupIds);
  return snapshot.messages.filter(m => !edited(m) && !m.deleted && m.sender.type === "user"
    && Date.parse(m.createdAt) >= Date.parse(snapshot.start) && Date.parse(m.createdAt) <= Date.parse(snapshot.end)
    && (direct.has(m.id) || (group.has(m.id) && (snapshot.meIds.includes(m.sender.id) || m.mentions.some(id => snapshot.meIds.includes(id))))))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function collectSnapshot(connector: MessageConnector, options: {
  start: string; end: string; meIds: string[]; maxPages: number;
  progress?: (operation: string, pages: number) => void;
}): Promise<Snapshot> {
  const identity = await connector.identity();
  const result: Snapshot = { version: 1, collectedAt: new Date().toISOString(), start: options.start, end: options.end,
    identity, meIds: options.meIds, messages: [], directIds: [], groupIds: [], coverage: [] };
  const messages = new Map<string, ChatMessage>();
  const collect = async (operation: Snapshot["coverage"][number]["operation"], key: string, start: string, end: string,
    read: (token?: string) => Promise<MessagePage>, ids?: string[]) => {
    const coverage: Snapshot["coverage"][number] = { operation, key, start, end, complete: false, pages: 0 };
    result.coverage.push(coverage);
    const seen = new Set<string>(); let token: string | undefined;
    try {
      for (; coverage.pages < options.maxPages;) {
        const page = await read(token); coverage.pages++;
        for (const m of page.messages) {
          if (Date.parse(m.createdAt) > Date.parse(result.end)) continue;
          const previous = messages.get(m.id);
          if (previous && JSON.stringify({ ...previous, chatName: undefined }) !== JSON.stringify({ ...m, chatName: undefined }))
            throw new Error("Message changed during collection; recollect a stable snapshot");
          messages.set(m.id, { ...m, ...(previous?.chatName || m.chatName ? { chatName: previous?.chatName || m.chatName } : {}) });
          if (ids && !ids.includes(m.id)) ids.push(m.id);
        }
        options.progress?.(operation, coverage.pages);
        if (!page.hasMore) { coverage.complete = true; return; }
        if (!page.nextToken || seen.has(page.nextToken)) throw new Error("Pagination incomplete or not advancing");
        token = page.nextToken; seen.add(token);
      }
      coverage.error = "Page budget exhausted";
    } catch (error) { coverage.error = error instanceof Error ? error.message : String(error); }
  };
  // Daily search windows bound collection and match the production source's maximum lookback.
  for (let start = Date.parse(options.start); start < Date.parse(options.end); start += 86_400_000) {
    const from = new Date(start).toISOString(), end = new Date(Math.min(start + 86_400_000, Date.parse(options.end))).toISOString();
    for (const kind of ["direct", "group", "sent"] as const) await collect(kind, "", from, end, token => connector.search({ start: from, end,
      chatType: kind === "direct" ? "p2p" : "group", ...(kind === "sent" ? { senderIds: options.meIds } : {}), ...(kind === "group" && options.meIds.length === 1 && options.meIds[0] === identity.userId ? { atMe: true } : {}),
      pageToken: token, limit: 50 }), kind === "direct" ? result.directIds : result.groupIds);
  }
  result.messages = [...messages.values()];
  const threads = new Set<string>(), chats = new Map<string, number>();
  for (const m of triggerMessages(result)) {
    chats.set(m.chatId, Math.min(chats.get(m.chatId) ?? Infinity, Date.parse(m.createdAt) - 900_000));
    if (m.threadId) threads.add(m.threadId);
  }
  // Follow-up is timed from discovery, which can be later than message creation in a batch.
  // One bounded history per touched chat covers those windows without rereading overlapping pages.
  for (const [chatId, from] of chats) {
    const start = new Date(from).toISOString(), end = options.end;
    await collect("history", chatId, start, end, token => connector.history({ chatId, start, end, pageToken: token, limit: 50, order: "asc" }));
  }
  for (const threadId of threads) {
    await collect("thread", threadId, options.start, options.end, token => connector.thread({ threadId, pageToken: token, limit: 50, order: "asc" }));
  }
  result.messages = [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return SnapshotSchema.parse(result);
}
