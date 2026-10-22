import { visibleOutput } from "../channel/output.ts";
import { webAddress } from "../channel/address.ts";
import { PersonSchema } from "../../plugins/personal/person/model.ts";
import { CHANNELS, bindChannelInput } from "../channel/definition.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Logger } from "pino";
import type { WebService } from "./service.ts";
import { validInputResult } from "../host/approval/answer.ts";
import { IncomingSchema } from "../channel/message.ts";
import { conversationList } from "../channel/view.ts";
import { streamConversation } from "./stream.ts";

const EventSchema = IncomingSchema.omit({ text: true, channelId: true, source: true }).extend({
  name: z.string().min(1).max(200), text: z.string().max(32_000),
});

const ConversationDefaultSchema = z.object({ conversationId: z.string().min(1), enabled: z.boolean() }).strict();

const ConversationTriggerSchema = z.object({ conversationId: z.string().min(1) }).extend({ enabled: z.boolean() }).strict();

const DeleteConversationSchema = z.object({ conversationId: z.string().min(1), uid: z.string().min(1), revision: z.number().int().positive() }).strict();

const DeleteWorkSchema = z.object({ id: z.string().min(1), conversationId: z.string().min(1) }).extend({
  revision: z.number().int().positive(),
}).strict();

const ApprovalResponseSchema = z.object({
  messageId: z.string().min(1),
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("hook_trust"), outcome: z.enum(["trusted", "skipped"]) }),
    z.object({ kind: z.literal("permission"), outcome: z.literal("selected"), optionId: z.string() }),
    z.object({ kind: z.literal("cancelled"), reason: z.literal("user") }),
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
  const receive = bindChannelInput(CHANNELS.web, (input) => aide.receive(input));
  const files = [
    ["/", "index.html", "text/html"],
    ["/people", "persons.html", "text/html"],
    ["/persons.js", "persons.js", "text/javascript"],
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
      if (request.method === "GET" && url.pathname === "/" && !url.searchParams.get("conversation")) {
        const selected = conversationList(aide).find((item) => item.default);
        if (selected) {
          url.searchParams.set("conversation", selected.id);
          response.writeHead(302, { location: url.pathname + url.search, "cache-control": "no-store" });
          response.end(); return;
        }
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
        const counts = new Map<string, { taskCount: number; routineCount: number }>();
        for (const work of aide.works()) {
          const count = counts.get(work.conversationId) ?? { taskCount: 0, routineCount: 0 };
          if (work.kind === "task") count.taskCount++; else count.routineCount++;
          counts.set(work.conversationId, count);
        }
        json(response, 200, conversationList(aide).map((item) => ({ ...item,
          ...(counts.get(item.id) ?? { taskCount: 0, routineCount: 0 }),
        }))); return;
      }
      if (request.method === "GET" && url.pathname === "/persons") {
        await aide.start();
        const id = url.searchParams.get("id");
        if (id) {
          try { json(response, 200, await aide.persons.read(id)); }
          catch (error) { if (!String(error).includes("Unknown Person")) throw error; json(response, 404, { error: "人物不存在。" }); }
        } else json(response, 200, await aide.persons.list());
        return;
      }
      if (request.method === "POST" && url.pathname === "/persons/edit") {
        const input = z.object({ id: z.string().min(1), uid: z.string().min(1), version: z.string().min(1), spec: PersonSchema }).strict().parse(await body(request));
        await aide.start();
        try { json(response, 200, await aide.persons.edit(input.id, input.uid, input.version, input.spec)); }
        catch (error) {
          if (String(error).includes("version conflict")) { json(response, 409, { error: "人物资料已更新。请重新加载并合并修改；当前编辑内容已保留。" }); return; }
          if (String(error).includes("identity") || String(error).includes("identities")) { json(response, 409, { error: "身份已绑定其他人物，或与 Me 标记冲突。请检查身份配置。" }); return; }
          throw error;
        }
        return;
      }
      // Native permissions and Hook trust are independent of conversation messages.
      if (request.method === "GET" && url.pathname === "/approvals") {
        json(response, 200, aide.sessions().flatMap((scope) => [...scope.core.projection.approvals.values()])
          .map((item) => item.request).filter((item) => item.status === "pending"));
      } else if (request.method === "POST" && url.pathname === "/approvals") {
        const { messageId, result } = ApprovalResponseSchema.parse(await body(request));
        const core = aide.sessions().find((scope) => scope.core.projection.approvals.has(messageId))?.core;
        const pending = core?.projection.approvals.get(messageId)?.request;
        if (!core || !pending || pending.status !== "pending") {
          json(response, 409, { error: "This approval is no longer pending" }); return;
        }
        if (!validInputResult(pending.request, result)) {
          json(response, 400, { error: "Answer does not match the pending approval" }); return;
        }
        // @spec Only an explicit, validated native approval response settles its pending request.
        const receipt = await core.resolveApproval({ kind: "approval_response", messageId }, async () => result);
        log.info({ messageId, kind: result.kind, completed: receipt.result }, "Native approval response");
        json(response, receipt.result ? 200 : 409, { completed: receipt.result });
      } else if (request.method === "POST" && url.pathname === "/messages") {
        const input = IncomingSchema.omit({ channelId: true, observation: true, source: true }).parse(await body(request));
        json(response, 200, await receive({ ...input, source: webAddress(input.sessionId) }));
      } else if (request.method === "POST" && url.pathname === "/conversations/default") {
        const { conversationId, enabled } = ConversationDefaultSchema.parse(await body(request));
        const resource = aide.findConversation(conversationId)?.conversations.resource(conversationId);
        if (!resource || resource.metadata.deletionTimestamp) { json(response, 404, { error: "会话不存在。" }); return; }
        await aide.setDefaultConversation(conversationId, enabled);
        json(response, 200, { conversationId, default: enabled });
      } else if (request.method === "POST" && url.pathname === "/conversations/trigger") {
        const { conversationId, enabled } = ConversationTriggerSchema.parse(await body(request));
        if (!aide.findConversation(conversationId)) {
          json(response, 404, { error: "会话不存在。" }); return;
        }
        json(response, 200, await aide.setConversationTrigger(conversationId, enabled));
      } else if (request.method === "POST" && url.pathname === "/conversations/delete") {
        const { conversationId, revision, uid } = DeleteConversationSchema.parse(await body(request));
        const result = await aide.deleteConversation(conversationId, revision, uid);
        if (result.deleted) { json(response, 200, result); return; }
        const errors = {
          missing: "该会话已删除或不存在。",
          changed: "会话已更新，请刷新后重新确认删除。",
          busy: "会话还有待处理输入、执行或问题，请处理完成后再删除。",
          work: "会话还有事项或安排，请先删除这些工作。",
        };
        log.info({ conversationId, revision, reason: result.reason }, "Conversation deletion rejected");
        json(response, result.reason === "missing" ? 404 : 409, { error: errors[result.reason] });
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
          const conversation = aide.findConversation(conversationId)?.conversations.resource(conversationId);
          const messages = aide.outputs().filter((item) => conversation && visibleOutput(item, conversation));
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
