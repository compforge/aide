import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { Logger } from "pino";
import type { Aide } from "../core/aide.ts";
import { IncomingSchema } from "../core/model.ts";

const EventSchema = IncomingSchema.omit({ text: true }).extend({
  name: z.string().min(1).max(200), text: z.string().max(32_000),
});

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error("Request body exceeds 128 KiB");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

/** Local channel bridge: accept messages/events and let adapters poll the durable outgoing log. */
export function httpChannel(aide: Aide, log: Logger) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "POST" && url.pathname === "/messages") {
        const input = IncomingSchema.parse(await body(request));
        json(response, 200, await aide.receive(input));
      } else if (request.method === "POST" && url.pathname === "/events") {
        json(response, 200, { matched: aide.event(EventSchema.parse(await body(request))) });
      } else if (request.method === "GET" && ["/messages", "/work"].includes(url.pathname)) {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) { json(response, 400, { error: "conversationId is required" }); return; }
        const state = aide.store.read();
        if (url.pathname === "/work") {
          json(response, 200, state.works.filter((work) => work.conversationId === conversationId));
        } else {
          const messages = state.messages.filter((item) => item.conversationId === conversationId && item.role === "aide");
          const after = url.searchParams.get("after");
          const index = after ? messages.findIndex((item) => item.id === after) : -1;
          if (after && index < 0) { json(response, 400, { error: "Unknown message cursor" }); return; }
          json(response, 200, messages.slice(index + 1));
        }
      } else {
        json(response, 404, { error: "Unknown route" });
      }
    } catch (error) {
      log.error({ err: error, path: request.url }, "Channel request failed");
      json(response, error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500,
        { error: "Request failed; check the Aide log" });
    }
  });
}
