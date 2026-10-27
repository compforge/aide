import { ChannelSettings, ChannelSettingsChangeSchema, ChannelSettingsError } from "../channel/settings.ts";
import { createWebAssets } from "./assets.ts";
import type { TopicItem } from "./types.ts";
import { visibleOutput } from "../channel/output.ts";
import { webAddress } from "../channel/address.ts";
import { SUMMARY_CHARS } from "../../plugins/personal/context.ts";
import { PersonSchema } from "../../plugins/personal/person/model.ts";
import { CHANNELS, bindChannelInput } from "../channel/definition.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { Logger } from "pino";
import type { WebService } from "./service.ts";
import { validInputResult } from "../host/approval/answer.ts";
import { IncomingSchema, webTopicLocator } from "../channel/message.ts";
import { topicList } from "../channel/view.ts";
import { streamTopic } from "./stream.ts";
import { renderHTML } from "@compforge/agent-observation";
import { inputObservation, ObservationQuery } from "./observation.ts";
import { inputList, inputDetail } from "./inputs.ts";

const EventSchema = IncomingSchema.omit({ text: true, channelId: true, source: true }).extend({
  name: z.string().min(1).max(200), text: z.string().max(32_000),
});

const TopicTriggerSchema = z.object({ topicId: z.string().min(1) }).extend({ enabled: z.boolean() }).strict();

const DeleteTopicSchema = z.object({ topicId: z.string().min(1), uid: z.string().min(1), revision: z.number().int().positive() }).strict();

const DeleteWorkSchema = z.object({ id: z.string().min(1), topicId: z.string().min(1) }).extend({
  revision: z.number().int().positive(),
}).strict();

const PersonVersionSchema = z.object({ id: z.string().min(1), uid: z.string().min(1), version: z.string().min(1) }).strict();
const MergePersonSchema = z.object({ source: PersonVersionSchema, target: PersonVersionSchema, summary: z.string().max(SUMMARY_CHARS) }).strict();
const InputListSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(200).optional(), origin: z.enum(["channel", "source", "chief", "trigger"]).optional(),
  originId: z.string().max(200).optional(), connector: z.string().max(200).optional(), sourceUid: z.string().max(200).optional(),
  state: z.enum(["pending", "completed"]).optional(), errors: z.enum(["true", "false"]).transform(v => v === "true").optional(),
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
export function httpChannel(aide: WebService, log: Logger, settings?: ChannelSettings) {
  const receive = bindChannelInput(CHANNELS.web, (input) => aide.receive(input));
  const assets = createWebAssets();
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
      if (request.method === "GET" && url.pathname === "/" && !url.searchParams.get("topic")) {
        const selected = topicList(aide).find((item) => item.default);
        if (selected) {
          url.searchParams.set("topic", selected.id);
          response.writeHead(302, { location: url.pathname + url.search, "cache-control": "no-store" });
          response.end(); return;
        }
      }
      const asset = request.method === "GET" ? await assets(url.pathname) : undefined;
      if (request.method === "GET" && asset) {
        response.writeHead(200, {
          "content-type": typeof asset.content === "string" ? `${asset.type}; charset=utf-8` : asset.type, "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        });
        response.end(asset.content); return;
      }
      if (url.pathname === "/channels/config" && (request.method === "GET" || request.method === "POST")) {
        if (!settings) { json(response, 503, { error: "此运行实例未提供配置编辑能力。" }); return; }
        json(response, 200, request.method === "GET" ? settings.snapshot() : settings.change(ChannelSettingsChangeSchema.parse(await body(request))));
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { status: "ok", revision: process.env.AIDE_REVISION ?? "development" }); return;
      }
      if (request.method === "GET" && url.pathname === "/stream") {
        const topicId = url.searchParams.get("topicId");
        if (!topicId || topicId.length > 200) { json(response, 400, { error: "topicId is required (max 200 characters)" }); return; }
        streamTopic(response, aide, topicId, log); return;
      }
      if (request.method === "GET" && url.pathname === "/topics") {
        const counts = new Map<string, { taskCount: number; routineCount: number }>();
        for (const work of aide.works()) {
          const count = counts.get(work.topicId) ?? { taskCount: 0, routineCount: 0 };
          if (work.kind === "task") count.taskCount++; else count.routineCount++;
          counts.set(work.topicId, count);
        }
        json(response, 200, topicList(aide).map((item) => ({ ...item,
          ...(counts.get(item.id) ?? { taskCount: 0, routineCount: 0 }),
        })) satisfies TopicItem[]); return;
      }
      if (request.method === "GET" && url.pathname === "/inputs/list") {
        const query = InputListSchema.parse(Object.fromEntries(url.searchParams));
        await aide.start(); json(response, 200, inputList(aide, query)); return;
      }
      if (request.method === "GET" && (url.pathname === "/inputs/job" || url.pathname === "/inputs/session")) {
        const query = ObservationQuery.parse(Object.fromEntries(url.searchParams));
        await aide.start();
        const view = await inputObservation(aide, url.pathname, query);
        if (!view) { json(response, 404, { error: "Input 或关联的 Session 不可用。" }); return; }
        response.setHeader("cache-control", "no-store");
        if (query.download) response.setHeader("content-disposition", `attachment; filename="${url.pathname.endsWith("job") ? "job" : "session"}.${query.format}"`);
        if (query.format === "html") {
          const html = renderHTML(view);
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
          response.end(html);
        } else json(response, 200, view);
        return;
      }
      if (request.method === "GET" && url.pathname === "/inputs/detail") {
        const query = z.object({ id: z.string().min(1).max(200), uid: z.string().min(1).max(250).optional() }).strict().parse(Object.fromEntries(url.searchParams));
        await aide.start();
        const detail = inputDetail(aide, query.id, query.uid);
        json(response, detail ? 200 : 404, detail ?? { error: "Input 已回收或不存在。" }); return;
      }
      if (request.method === "GET" && url.pathname === "/persons") {
        await aide.start();
        const id = url.searchParams.get("id");
        if (id) {
          try { json(response, 200, await aide.persons.read(id, url.searchParams.get("uid") ?? undefined)); }
          catch (error) { if (!String(error).includes("Unknown Person")) throw error; json(response, 404, { error: "人物不存在。" }); }
        } else json(response, 200, await aide.persons.list());
        return;
      }
      if (request.method === "POST" && url.pathname === "/persons/edit") {
        const input = z.object({ id: z.string().min(1), uid: z.string().min(1), version: z.string().min(1), spec: PersonSchema, summary: z.string().max(SUMMARY_CHARS).optional() }).strict().parse(await body(request));
        await aide.start();
        try { json(response, 200, await aide.persons.edit(input.id, input.uid, input.version, input.spec, input.summary)); }
        catch (error) {
          if (String(error).includes("version conflict")) { json(response, 409, { error: "人物资料已更新。请重新加载并合并修改；当前编辑内容已保留。" }); return; }
          if (String(error).includes("identity") || String(error).includes("identities")) { json(response, 409, { error: "身份已绑定其他人物，或与 Me 标记冲突。请检查身份配置。" }); return; }
          throw error;
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/persons/merge") {
        const input = MergePersonSchema.parse(await body(request));
        await aide.start();
        const attributes = { sourceId: input.source.id, sourceUid: input.source.uid, targetId: input.target.id, targetUid: input.target.uid };
        try {
          const merged = await aide.persons.merge(input.source, input.target, input.summary);
          log.info(attributes, "Persons merged; source deletion requested");
          json(response, 200, merged);
        } catch (error) {
          log.warn({ ...attributes, err: error }, "Person merge failed");
          if (/version conflict|incarnation changed|Unknown Person|not found/.test(String(error))) {
            json(response, 409, { error: "人物资料已更新或删除。请取消并重新加载，再核对合并内容。" }); return;
          }
          if (String(error).includes("into itself")) { json(response, 400, { error: "不能将人物合并到自己。" }); return; }
          if (/identity|identities/.test(String(error)) && !(error instanceof z.ZodError)) {
            json(response, 409, { error: "人物身份已变化，请重新加载后核对。" }); return;
          }
          throw error;
        }
        return;
      }
      // Native permissions and Hook trust are independent of topic messages.
      if (request.method === "GET" && url.pathname === "/approvals") {
        json(response, 200, aide.runtime.executions.approvals()
          .map((item) => item.request).filter((item) => item.status === "pending"));
      } else if (request.method === "POST" && url.pathname === "/approvals") {
        const { messageId, result } = ApprovalResponseSchema.parse(await body(request));
        const core = aide.runtime;
        const pending = core?.executions.approval(messageId);
        if (!core || !pending || pending.status !== "pending") {
          json(response, 409, { error: "This approval is no longer pending" }); return;
        }
        if (!validInputResult(pending.request, result)) {
          json(response, 400, { error: "Answer does not match the pending approval" }); return;
        }
        // @spec Only an explicit, validated native approval response settles its pending request.
        const completed = core.executions.resolveApproval(messageId, result);
        log.info({ messageId, kind: result.kind, completed: completed }, "Native approval response");
        json(response, completed ? 200 : 409, { completed: completed });
      } else if (request.method === "POST" && url.pathname === "/messages") {
        const input = IncomingSchema.omit({ channelId: true, observation: true, source: true, topicKey: true, topicName: true }).extend({ topicId: z.string().min(1) }).parse(await body(request));
        const topicId = webTopicLocator.locate(input).selector.id;
        json(response, 200, await receive({ ...input, topicId, source: webAddress(topicId) }));
      } else if (request.method === "POST" && url.pathname === "/topics/trigger") {
        const { topicId, enabled } = TopicTriggerSchema.parse(await body(request));
        if (!aide.topics.get(topicId)) {
          json(response, 404, { error: "会话不存在。" }); return;
        }
        json(response, 200, await aide.setTopicTrigger(topicId, enabled));
      } else if (request.method === "POST" && url.pathname === "/topics/delete") {
        const { topicId, revision, uid } = DeleteTopicSchema.parse(await body(request));
        const result = await aide.deleteTopic(topicId, revision, uid);
        if (result.deleted) { json(response, 200, result); return; }
        const errors = {
          missing: "该主题已删除或不存在。",
          changed: "主题已更新，请刷新后重新确认删除。",
          busy: "主题还有待处理输入、执行或正在整理，请处理完成后再删除。",
          work: "主题还有事项或安排，请先删除这些工作。",
          default: "默认主题不能删除。",
          children: "主题还有子主题，请先处理子主题。",
          unabsorbed: "父主题尚未吸收该主题的最新理解，暂时不能删除。",
        };
        log.info({ topicId, revision, reason: result.reason }, "Topic deletion rejected");
        json(response, result.reason === "missing" ? 404 : 409, { error: errors[result.reason] });
      } else if (request.method === "POST" && url.pathname === "/work/delete") {
        const { id, topicId, revision } = DeleteWorkSchema.parse(await body(request));
        const work = aide.works().find((item) => item.id === id && item.topicId === topicId);
        if (!work) { json(response, 404, { error: "该工作已删除或不属于当前会话。" }); return; }
        if (work.revision !== revision) {
          json(response, 409, { error: "工作已更新，请刷新后重新确认删除。" }); return;
        }
        // @spec Web deletion uses the same scoped, revision-checked lifecycle as Chief's Work tools.
        await aide.work(topicId).delete(id, revision);
        json(response, 200, { deleted: true });
      } else if (request.method === "POST" && url.pathname === "/events") {
        json(response, 200, { matched: await aide.event(EventSchema.parse(await body(request))) });
      } else if (request.method === "GET" && ["/messages", "/work"].includes(url.pathname)) {
        const topicId = url.searchParams.get("topicId");
        if (!topicId) { json(response, 400, { error: "topicId is required" }); return; }
        if (url.pathname === "/work") {
          json(response, 200, aide.works().filter((work) => work.topicId === topicId));
        } else {
          const topic = aide.topics.resource(topicId);
          const messages = aide.outputs().filter((item) => topic && visibleOutput(item, topic));
          const after = url.searchParams.get("after");
          const index = after ? messages.findIndex((item) => item.id === after) : -1;
          if (after && index < 0) { json(response, 400, { error: "Unknown message cursor" }); return; }
          json(response, 200, messages.slice(index + 1));
        }
      } else {
        json(response, 404, { error: "Unknown route" });
      }
    } catch (error) {
      if (error instanceof ChannelSettingsError) { json(response, error.status, { error: error.message }); return; }
      log.error({ err: error, path: request.url }, "Channel request failed");
      json(response, error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500,
        { error: "Request failed; check the Aide log" });
    }
  });
}
