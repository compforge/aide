import type { ServerResponse } from "node:http";
import type { Logger } from "pino";
import type { Aide } from "../../plugins/personal/aide.ts";
import { encodeSse, PatchEmitter, type PatchEvent } from "@compforge/agentue/ui";
import { conversationView, type ConversationView } from "./view.ts";

/**
 * @spec AgentUE owns patch semantics; Aide selects the conversation's renderable state.
 * @why Removed/reordered blocks require a replacement start because AgentUE has no delete operation.
 * @link docs/web-progress.md
 */
export function conversationPatches(emitter: PatchEmitter, previous: ConversationView | undefined, next: ConversationView): PatchEvent[] {
  if (!previous || previous.blocks.some((block, index) => next.blocks[index]?.id !== block.id)) return [emitter.start(next)];
  const events: PatchEvent[] = [];
  if (JSON.stringify(previous.meta.activity) !== JSON.stringify(next.meta.activity)) {
    events.push(emitter.metaSet("meta.activity", { activity: next.meta.activity }));
  }
  next.blocks.forEach((block, index) => {
    const old = previous.blocks[index];
    if (JSON.stringify(old) === JSON.stringify(block)) return;
    if (old && block.content.startsWith(old.content) && JSON.stringify(old) === JSON.stringify({ ...block, content: old.content })) {
      events.push(emitter.blockAppend({ id: block.id, type: block.type, content: block.content.slice(old.content.length) }));
    } else events.push(emitter.blockSet(block));
  });
  return events;
}

/** Every connection starts a fresh delivery from the authoritative projection, without replaying actions. */
export function streamConversation(response: ServerResponse, aide: Aide, conversationId: string, log: Logger): void {
  const initial = conversationView(aide, conversationId);
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
  const emitter = new PatchEmitter();
  let previous = initial;
  let blocked = false, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (error?: PatchEvent) => {
    if (closed) return;
    closed = true;
    response.end((error ? encodeSse(error) : "") + encodeSse(emitter.end()));
  };
  const flush = () => {
    timer = undefined;
    if (closed || blocked) return;
    try {
      const next = conversationView(aide, conversationId);
      const events = conversationPatches(emitter, previous, next);
      previous = next;
      if (events.length) blocked = !response.write(events.map((event) => encodeSse(event)).join(""));
    } catch (err) {
      log.error({ err, conversationId }, "Web conversation stream failed");
      finish(emitter.error("view_failed", "无法更新对话进展，请重新连接。"));
    }
  };
  // Coalesce token bursts without delaying model execution or rebuilding the page for each token.
  const schedule = () => { if (!closed && !timer) timer = setTimeout(flush, 100); };
  const unsubscribe = aide.channel.subscribe(schedule);
  const unsubscribeConversation = aide.store.conversations.subscribe((conversation) => {
    if (conversation.id === conversationId) schedule();
  });
  // Domain Work outboxes can change independently of the Core event stream.
  const refresh = setInterval(schedule, 1500);
  const heartbeat = setInterval(() => { if (!closed && !blocked) blocked = !response.write(encodeSse(emitter.ping())); }, 15_000);
  // Bound delivery lifetime; EventSource reconnects with a new start snapshot, not a replay cursor.
  const lifetime = setTimeout(() => finish(), 5 * 60_000);
  response.on("drain", () => { blocked = false; schedule(); });
  response.on("close", () => {
    closed = true;
    clearTimeout(timer); clearTimeout(lifetime); clearInterval(refresh); clearInterval(heartbeat);
    unsubscribe(); unsubscribeConversation();
  });
  blocked = !response.write(encodeSse(emitter.start(initial)));
}
