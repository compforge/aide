import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Logger } from "pino";
import type { Aide } from "../../plugins/personal/aide.ts";
import { validInputResult } from "../runtime/interaction/answer.ts";
import { IncomingSchema } from "../../plugins/personal/model.ts";

const EventSchema = IncomingSchema.omit({ text: true }).extend({
  name: z.string().min(1).max(200), text: z.string().max(32_000),
});

const InteractionResponseSchema = z.object({
  messageId: z.string().min(1),
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("hook_trust"), outcome: z.enum(["trusted", "skipped"]) }),
    z.object({ kind: z.literal("permission"), outcome: z.literal("selected"), optionId: z.string() }),
    z.object({ kind: z.literal("cancelled"), reason: z.literal("user") }),
    z.object({ kind: z.literal("question"), outcome: z.literal("answered"), answers: z.record(z.string(), z.array(z.string().min(1))) }),
  ]),
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
  const page = readFileSync(new URL("./web.html", import.meta.url), "utf8");
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      // Browsers can be directed to a local agent by unrelated websites.
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
        json(response, 403, { error: "Cross-origin requests are not allowed" }); return;
      }
      if (request.method === "POST" && request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
        json(response, 415, { error: "Content-Type must be application/json" }); return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        });
        response.end(page); return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { status: "ok", revision: process.env.AIDE_REVISION ?? "development" }); return;
      }
      // This is the local user's Session-wide inbox, independent of personal conversation IDs.
      if (request.method === "GET" && url.pathname === "/interactions") {
        json(response, 200, [...aide.channel.projection.interactions.values()]
          .map((item) => item.request).filter((item) => item.status === "pending"));
      } else if (request.method === "POST" && url.pathname === "/interactions") {
        const { messageId, result } = InteractionResponseSchema.parse(await body(request));
        const pending = aide.channel.projection.interactions.get(messageId)?.request;
        if (!pending || pending.status !== "pending") {
          json(response, 409, { error: "This interaction is no longer pending" }); return;
        }
        if (!validInputResult(pending.request, result)) {
          json(response, 400, { error: "Answer does not match the pending interaction" }); return;
        }
        // @spec Channel answers settle Aide's original Interaction; no separate approval state.
        const receipt = await aide.channel.resolveInteraction({ kind: "interaction_response", messageId }, async () => result);
        log.info({ messageId, kind: result.kind, completed: receipt.result }, "Channel interaction response");
        json(response, receipt.result ? 200 : 409, { completed: receipt.result });
      } else if (request.method === "POST" && url.pathname === "/messages") {
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
          const messages = aide.messages().filter((item) => item.conversationId === conversationId
            && (url.searchParams.get("role") === "all" || item.role === "aide"));
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
