import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Logger } from "pino";
import type { WebService } from "./service.ts";
import { validInputResult } from "../host/interaction/answer.ts";
import { IncomingSchema } from "../channel/message.ts";
import { conversationList } from "../channel/view.ts";
import { streamConversation } from "./stream.ts";

const EventSchema = IncomingSchema.omit({ text: true }).extend({
  name: z.string().min(1).max(200), text: z.string().max(32_000),
});

const DeleteWorkSchema = IncomingSchema.pick({ id: true, conversationId: true }).extend({
  revision: z.number().int().positive(),
}).strict();

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
export function httpChannel(aide: WebService, log: Logger) {
  const files = [
    ["/", "index.html", "text/html"],
    ["/app.js", "app.js", "text/javascript"],
    ["/style.css", "style.css", "text/css"],
  ] as const;
  const assets = new Map<string, { type: string; content: string }>(files.map(([path, file, type]) =>
    [path, { type, content: readFileSync(new URL(`../web/${file}`, import.meta.url), "utf8") }]));
  let webSdk: Promise<string> | undefined;
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
      const asset = assets.get(url.pathname);
      if (request.method === "GET" && asset) {
        response.writeHead(200, {
          "content-type": `${asset.type}; charset=utf-8`, "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        });
        response.end(asset.content); return;
      }
      if (request.method === "GET" && url.pathname === "/agentue.js") {
        webSdk ??= Bun.build({ entrypoints: [fileURLToPath(new URL("../web/sdk.ts", import.meta.url))], target: "browser", format: "esm", minify: true })
          .then(async (build) => {
            if (!build.success) throw new AggregateError(build.logs, "AgentUE browser bundle failed");
            return build.outputs[0]!.text();
          });
        const script = await webSdk;
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
        response.end(script); return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { status: "ok", revision: process.env.AIDE_REVISION ?? "development" }); return;
      }
      if (request.method === "GET" && url.pathname === "/stream") {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId || conversationId.length > 200) { json(response, 400, { error: "conversationId is required (max 200 characters)" }); return; }
        streamConversation(response, aide, conversationId, log); return;
      }
      if (request.method === "GET" && url.pathname === "/conversations") {
        json(response, 200, conversationList(aide)); return;
      }
      // Unscoped interactions remain in the local inbox; scoped questions follow their conversation.
      if (request.method === "GET" && url.pathname === "/interactions") {
        json(response, 200, aide.sessions().flatMap((scope) => [...scope.core.projection.interactions.values()])
          .filter((item) => !url.searchParams.has("conversationId") || !item.pluginContext?.conversationId || item.pluginContext.conversationId === url.searchParams.get("conversationId"))
          .map((item) => item.request).filter((item) => item.status === "pending"));
      } else if (request.method === "POST" && url.pathname === "/interactions") {
        const { messageId, result } = InteractionResponseSchema.parse(await body(request));
        const core = aide.sessions().find((scope) => scope.core.projection.interactions.has(messageId))?.core;
        const pending = core?.projection.interactions.get(messageId)?.request;
        if (!core || !pending || pending.status !== "pending") {
          json(response, 409, { error: "This interaction is no longer pending" }); return;
        }
        if (!validInputResult(pending.request, result)) {
          json(response, 400, { error: "Answer does not match the pending interaction" }); return;
        }
        // @spec Channel answers settle Aide's original Interaction; no separate approval state.
        const receipt = await core.resolveInteraction({ kind: "interaction_response", messageId }, async () => result);
        log.info({ messageId, kind: result.kind, completed: receipt.result }, "Channel interaction response");
        json(response, receipt.result ? 200 : 409, { completed: receipt.result });
      } else if (request.method === "POST" && url.pathname === "/messages") {
        const input = IncomingSchema.parse(await body(request));
        json(response, 200, await aide.receive(input));
      } else if (request.method === "POST" && url.pathname === "/work/delete") {
        const { id, conversationId, revision } = DeleteWorkSchema.parse(await body(request));
        const work = aide.works().find((item) => item.id === id && item.conversationId === conversationId);
        if (!work) { json(response, 404, { error: "该工作已删除或不属于当前会话。" }); return; }
        if (work.revision !== revision) {
          json(response, 409, { error: "工作已更新，请刷新后重新确认删除。" }); return;
        }
        // @spec Web deletion uses the same scoped, revision-checked lifecycle as Chief's Work tools.
        await aide.work(conversationId).delete(id, revision);
        json(response, 200, { deleted: true });
      } else if (request.method === "POST" && url.pathname === "/events") {
        json(response, 200, { matched: await aide.event(EventSchema.parse(await body(request))) });
      } else if (request.method === "GET" && ["/messages", "/work"].includes(url.pathname)) {
        const conversationId = url.searchParams.get("conversationId");
        if (!conversationId) { json(response, 400, { error: "conversationId is required" }); return; }
        if (url.pathname === "/work") {
          json(response, 200, aide.works().filter((work) => work.conversationId === conversationId));
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
