import type { ServerResponse } from "node:http";
import type { Logger } from "pino";
import type { Aide } from "../../plugins/personal/aide.ts";
import { conversationView } from "./view.ts";

/** SSE carries replacement snapshots: initial load and reconnect use the same authoritative projection. */
export function streamConversation(response: ServerResponse, aide: Aide, conversationId: string, log: Logger): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
  let previous = "", blocked = false, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (closed || blocked) return;
    try {
      const data = JSON.stringify(conversationView(aide, conversationId));
      if (data === previous) return;
      previous = data;
      blocked = !response.write(`event: view\ndata: ${data}\n\n`);
    } catch (err) {
      log.error({ err, conversationId }, "Web conversation stream failed");
      response.destroy();
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
  const heartbeat = setInterval(() => { if (!blocked) blocked = !response.write(": ping\n\n"); }, 15_000);
  response.on("drain", () => { blocked = false; schedule(); });
  response.on("close", () => {
    closed = true;
    clearTimeout(timer); clearInterval(refresh); clearInterval(heartbeat);
    unsubscribe(); unsubscribeConversation();
  });
  flush();
}
