import { iconFor, type InputSpec } from "@compforge/aide-plugin";
import { CHANNELS, bindChannelInput } from "../src/channel/definition.ts";
import { SOURCES } from "../plugins/personal/source/definition.ts";
import { HARNESS_IDENTITIES, harnessIdentityFor } from "../src/host/harness/ids.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pino from "pino";
import { decodeSse, PatchEmitter, applyPatch, type PatchEvent } from "@compforge/agentue/ui";
import { Aide } from "../src/app.ts";
import { chiefTarget } from "../plugins/personal/chief-model.ts";
import { httpChannel } from "../src/api/index.ts";
import { conversationView, type ConversationView } from "../src/channel/view.ts";
import { conversationPatches } from "../src/api/stream.ts";
import type { HarnessEventSink } from "../src/host/harness/adapter.ts";
import { fakeOptions } from "./fake-harness.ts";
import { seedInput } from "./conversation-fixture.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await Bun.sleep(10); }
  assert.fail("Timed out waiting for web progress");
}

test("Web receives scoped progress before final reply, reconnects with a snapshot, and never delivers progress as messages", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-web-progress-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const emitters = new Map<string, { sink: HarnessEventSink; turnId: string }>();
  const options = fakeOptions({ async chief() { await gate; return "最终答复"; }, async execute() { throw new Error("Unexpected Work"); } }, root);
  const log = pino({ level: "silent" });
  const aide = new Aide(root, { ...options, createAdapter(target) {
    const adapter = options.createAdapter(target);
    const open = adapter.open.bind(adapter), send = adapter.sendTurn.bind(adapter);
    let sink: HarnessEventSink;
    adapter.open = async (...args) => { sink = args[1]; return open(...args); };
    adapter.sendTurn = async (ref, input) => { emitters.set(target.id, { sink, turnId: input.turnId }); return send(ref, input); };
    return adapter;
  } }, log);
  const server = httpChannel(aide, log);
  const connections: AbortController[] = [];
  t.after(async () => {
    for (const connection of connections) connection.abort();
    release(); await aide.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const page = await fetch(base);
  assert.match(page.headers.get("content-security-policy")!, /script-src 'self'/);
  assert.match(await page.text(), /src="\/app.js"/);
  const bundle = await fetch(base + "/agentue.js");
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get("content-type")!, /javascript/);
  const browserSdk = await import(`data:text/javascript;base64,${Buffer.from(await bundle.text()).toString("base64")}`) as typeof import("../src/web/sdk.ts");
  assert.match(browserSdk.renderMarkdown("## 网页回复\n\n- **已完成**"), /<h2>网页回复<\/h2>[\s\S]*<strong>已完成<\/strong>/);
  assert.doesNotMatch(browserSdk.renderMarkdown('<script>alert(1)</script>'), /<script>/);
  async function connect(conversationId: string) {
    const controller = new AbortController(); connections.push(controller);
    const response = await fetch(`${base}/stream?conversationId=${conversationId}`, { signal: controller.signal });
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const views: ConversationView[] = [];
    const events: PatchEvent[] = [];
    let snapshot = {};
    const reader = response.body!.getReader();
    const reading = (async () => {
      let buffer = ""; const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const { event } = decodeSse(frame);
          events.push(event);
          snapshot = browserSdk.applyPatch(snapshot, event);
          views.push(structuredClone(snapshot) as ConversationView);
        }
      }
    })().catch((error) => { if (!controller.signal.aborted) throw error; });
    return { views, events, close: async () => { controller.abort(); await reading; } };
  }
  assert.equal((await fetch(base + "/stream")).status, 400);
  assert.equal((await fetch(base + "/stream?conversationId=a", { headers: { origin: "https://foreign.test" } })).status, 403);
  const first = await connect("a");
  await until(() => first.views.length > 0);
  assert.equal(first.events[0]!.op, "start");
  assert.deepEqual(first.views[0], { version: "1.0", biz: "aide.conversation", blocks: [], meta: { conversation_id: "a", activity: null } });
  const accepted = await fetch(base + "/messages", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "a1", sessionId: "a", text: "查看资料", channelId: "forged-channel" }) });
  assert.equal(accepted.status, 200);
  await aide.receive({ channelId: "web", id: "b1", sessionId: "b", conversationId: "b", text: "另一会话的私有内容" });
  await until(() => emitters.has(chiefTarget("a")) && emitters.has(chiefTarget("b")));
  const { sink, turnId } = emitters.get(chiefTarget("a"))!;
  const other = emitters.get(chiefTarget("b"))!;
  other.sink({ kind: "agent_thought_chunk", turnId: other.turnId, payload: { messageId: "thought-b", content: { type: "text", text: "另一会话的思考" } } });
  sink({ kind: "agent_thought_chunk", turnId, payload: { messageId: "thought-a", content: { type: "text", text: "先检查资料" } } });
  sink({ kind: "tool_call_update", turnId, payload: { toolCallId: "read-a", title: "read", status: "in_progress", rawInput: { path: "/tmp/README" } } });
  sink({ kind: "agent_message_chunk", turnId, payload: { messageId: "text-a", content: { type: "text", text: "正在整理" } } });
  await until(() => first.views.some((view) => view.blocks.some((block) => block.content === "正在整理")));
  const progress = first.views.at(-1)!;
  assert.equal(progress.blocks.filter((block) => block.parent_id).length, 3);
  assert.equal(progress.blocks.find((block) => block.type === "execution")!.status, "running");
  assert.equal(progress.blocks.find((block) => block.type === "execution")!.harness, "chief");
  assert.equal(progress.blocks.find((block) => block.type === "execution")!.icon, HARNESS_IDENTITIES.chief.icon);
  const channel = progress.blocks.find((block) => block.role === "user")!;
  assert.equal(channel.originId, CHANNELS.web.id, "HTTP selects its own Channel identity");
  assert.equal(channel.label, CHANNELS.web.label);
  assert.equal(channel.icon, CHANNELS.web.icon);
  assert.equal(progress.blocks.find((block) => block.type === "tool")!.detail, "/tmp/README");
  assert.doesNotMatch(JSON.stringify(progress), /另一会话/);
  assert.equal(aide.messages().filter((message) => message.role === "aide").length, 0);
  sink({ kind: "agent_message_chunk", turnId, payload: { messageId: "text-a", content: { type: "text", text: "重点" } } });
  await until(() => first.events.some((event) => event.op === "append"));
  assert.equal(first.views.at(-1)!.blocks.at(-1)!.content, "正在整理重点");
  await first.close();
  sink({ kind: "agent_message_chunk", turnId, payload: { messageId: "text-a", content: { type: "text", text: "，请稍候" } } });
  const second = await connect("a");
  await until(() => second.views.length > 0);
  assert.equal(second.events[0]!.op, "start");
  assert.equal(second.views[0]!.blocks.at(-1)!.content, "正在整理重点，请稍候");
  release(); await aide.settled();
  await until(() => second.views.at(-1)?.meta.activity === null && second.views.at(-1)!.blocks.filter((block) => block.type === "message").length === 1);
  assert.equal(second.views.at(-1)!.blocks.filter((block) => block.role === "aide").length, 1);
  assert.equal(second.views.at(-1)!.blocks.filter((block) => block.type === "message").at(-1)!.content, "最终答复");
  const completed = second.views.at(-1)!;
  assert.equal(completed.blocks.find((block) => block.type === "execution")!.status, "completed");
  const groupId = completed.blocks.find((block) => block.type === "execution")!.group_id;
  assert.ok(groupId, "Execution grouping must use durable Input ownership");
  assert.equal(completed.blocks.find((block) => block.role === "aide")!.group_id, groupId);
  assert.equal(completed.blocks.filter((block) => block.type === "input").length, 1);
  assert.equal(completed.blocks.find((block) => block.role === "user")!.group_id, undefined);
  assert.equal(completed.blocks.find((block) => block.role === "user")!.origin, "channel");
  assert.equal(completed.blocks.find((block) => block.role === "user")!.inputId, groupId);
  assert.equal(completed.blocks.find((block) => block.type === "execution")!.harness, "chief");
  assert.equal(completed.blocks.find((block) => block.type === "thought")!.content, "先检查资料");
  assert.equal(completed.blocks.find((block) => block.type === "tool")!.detail, "/tmp/README");
  assert.doesNotMatch(JSON.stringify(completed), /另一会话/);
  const refreshed = await connect("a");
  await until(() => refreshed.views.length > 0);
  assert.deepEqual(refreshed.views[0], completed);
  await refreshed.close();
  assert.equal(aide.works().length, 0);
  const messages = aide.messages.bind(aide);
  aide.messages = () => { throw new Error("projection unavailable"); };
  try {
    await until(() => second.events.at(-1)?.op === "end");
    assert.deepEqual(second.events.slice(-2).map((event) => event.op), ["error", "end"]);
    assert.equal(second.views.at(-1)!.meta.error!.code, "view_failed");
    assert.equal((await fetch(base + "/stream?conversationId=a")).status, 500);
  } finally { aide.messages = messages; }
  await second.close();
  await aide.receive({ channelId: "web", id: "a2", sessionId: "a", conversationId: "a", text: "再聊一个问题" });
  await aide.settled();
  const later = conversationView(aide, "a");
  assert.equal(later.blocks.filter((block) => block.type === "execution").length, 2);
  assert.equal(new Set(later.blocks.filter((block) => block.type === "execution").map((block) => block.group_id)).size, 2);
  for (const reply of later.blocks.filter((block) => block.role === "aide")) {
    assert.ok(later.blocks.some((block) => block.type === "execution" && block.group_id === reply.group_id));
  }
  assert.equal(later.blocks.find((block) => block.type === "thought")!.parent_id,
    completed.blocks.find((block) => block.type === "execution")!.id);
  await aide.close();
  const reopened = new Aide(root, options, log);
  try {
    assert.deepEqual(conversationView(reopened, "a"), later);
    assert.doesNotMatch(JSON.stringify(conversationView(reopened, "a")), /另一会话/);
  } finally { await reopened.close(); }
});

test("AgentUE reducer reconstructs growing, corrected and removed progress without duplicated text", () => {
  const emitter = new PatchEmitter();
  const initial: ConversationView = { version: "1.0", biz: "aide.conversation", meta: { conversation_id: "a", activity: null },
    blocks: [{ id: "output:answer", type: "text", content: "整理" }] };
  let previous: ConversationView | undefined;
  let snapshot = {};
  for (const next of [initial,
    { ...initial, blocks: [{ id: "output:answer", type: "text" as const, content: "整理重点" }] },
    { ...initial, blocks: [{ id: "output:answer", type: "text" as const, content: "已完成" }] },
    { ...initial, blocks: [] }]) {
    for (const event of conversationPatches(emitter, previous, next)) snapshot = applyPatch(snapshot, event);
    assert.deepEqual(snapshot, next);
    previous = next;
  }
});


test("Web associates failed replies with their Input so interruption warnings remain visible", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-web-failed-reply-"));
  const aide = new Aide(root, fakeOptions({
    chief: async () => { throw new Error("controlled model failure"); },
    execute: async () => { throw new Error("No Work expected"); },
  }, root), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive({ channelId: "web", id: "failed-reply", sessionId: "failed", conversationId: "failed", text: "检查展示故障" });
  await aide.settled();
  const view = conversationView(aide, "failed");
  const reply = view.blocks.find((block) => block.role === "aide")!;
  assert.equal(reply.status, "failed");
  assert.equal(reply.group_id, aide.session("failed").conversations.inputs("failed")[0]!.metadata.name);
  assert.ok(aide.invocations().some((invocation) => invocation.inputId === reply.group_id));
  assert.match(reply.content, /未完成/);
});


test("Source receipts expose original evidence before processing and remain visible after quiet consumption and restart", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-web-source-inputs-"));
  const options = fakeOptions({ async execute() { throw new Error("No Work expected"); } }, root);
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const store = aide.session("inbox").conversations;
  await assert.rejects(store.submit("missing-origin", { origin: "source", text: "缺少来源身份" } as InputSpec), /originId/);
  assert.equal(store.inputStore.get("missing-origin"), undefined);
  const observation = { type: "workload.changed", environment: "test", namespace: "vke-system", changes: [
    { before: { kind: "Deployment", name: "sandbox-server", generation: 1129 }, after: { kind: "Deployment", name: "sandbox-server", generation: 1130 } },
  ] };
  await seedInput(store, "environment", { origin: "source", originId: SOURCES.environments.id, text: "test / vke-system：Deployment sandbox-server generation 1129 → 1130", observation }, { phase: "done", quietReason: "No delegated work" });
  await seedInput(store, "mention", { origin: "source", originId: SOURCES.lark.id, text: "Lark 群内 @：请确认发布窗口", observation: {
    provider: "lark", kind: "mention", message: { id: "om_example", content: "请确认发布窗口" }, context: { messages: [{ content: "完整上下文" }] },
  } });
  await seedInput(store, "failed", { origin: "source", originId: SOURCES.requirements.id, text: "其它 Source 的原始输入" }, { phase: "failed" });
  await seedInput(aide.session("other").conversations, "private", { origin: "source", originId: "personal.environments", text: "另一会话的私有输入" });
  const view = conversationView(aide, "inbox");
  const receipts = view.blocks.filter((block) => block.type === "input");
  assert.equal(receipts.length, 3);
  assert.equal(new Set(receipts.map((block) => block.id)).size, 3);
  const environment = receipts.find((block) => block.inputId === "environment")!;
  assert.equal(environment.origin, "source");
  assert.equal(environment.originId, SOURCES.environments.id);
  assert.equal(environment.icon, SOURCES.environments.icon);
  assert.equal(environment.label, SOURCES.environments.label);
  assert.equal(environment.status, "quiet");
  assert.match(environment.content, /Deployment sandbox-server/);
  assert.deepEqual(JSON.parse(environment.detail!.split("\n\nObservation:\n")[1]!), observation);
  const mention = receipts.find((block) => block.inputId === "mention")!;
  assert.equal(mention.status, "queued");
  assert.equal(mention.icon, SOURCES.lark.icon);
  assert.equal(receipts.find((block) => block.inputId === "failed")!.icon, SOURCES.requirements.icon);
  assert.equal(mention.content, "Lark 群内 @：请确认发布窗口");
  assert.match(mention.detail!, /完整上下文/);
  assert.equal(receipts.find((block) => block.inputId === "failed")!.status, "failed");
  assert.match(receipts.find((block) => block.inputId === "failed")!.detail!, /其它 Source 的原始输入/);
  assert.doesNotMatch(JSON.stringify(view), /另一会话/);
  assert.equal(aide.messages().length, 0, "Showing Input facts must not manufacture outbound messages");
  // Close without starting a Runner: queued and consumed receipts both reconstruct directly from persisted facts.
  await aide.close(); aide = new Aide(root, options, pino({ level: "silent" }));
  assert.deepEqual(conversationView(aide, "inbox"), view);
});

test("Harness presentation resolves persisted wire names and canonical IDs to the same definition", () => {
  for (const identity of Object.values(HARNESS_IDENTITIES)) {
    assert.equal(harnessIdentityFor(identity.sessionKey), identity);
    assert.equal(harnessIdentityFor(identity.id), identity);
  }
  assert.equal(harnessIdentityFor("external-harness"), undefined);
});

test("Category icon assignments remain fixed independently of lookup order", () => {
  const assignments = [
    ["channel:web", "M12 3 3 8l9 5 9-5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"],
    ["source:personal.requirements", "M3 4h18v16H3zM3 8h18M7 12h10M7 16h6"],
    ["harness:codex", "M5 4h14q3 0 3 3v10q0 3-3 3H5q-3 0-3-3V7q0-3 3-3zM7 9l3 3-3 3M13 15h4"],
  ] as const;
  for (const [category, icon] of [...assignments].reverse()) assert.equal(iconFor(category), icon);
  for (const [category, icon] of assignments) assert.equal(iconFor(category), icon);
});

test("Bound Channels preserve distinct input identities and rebuild user/source history without Message copies after restart", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-bound-inputs-"));
  const prompts: string[] = [];
  const options = fakeOptions({ async chief(prompt) { prompts.push(prompt); return "处理完成"; },
    async execute() { throw new Error("No Work expected"); } }, root);
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const web = bindChannelInput(CHANNELS.web, (input) => aide.receive(input));
  const lark = bindChannelInput(CHANNELS.lark, (input) => aide.receive(input));
  const input = { id: "same-external-id", sessionId: "inbox", text: "Web 用户交代" };
  const receipt = await web(input); await aide.settled();
  assert.deepEqual(await web(input), receipt);
  const other = await lark({ ...input, text: "Lark 用户补充" }); await aide.settled();
  assert.notEqual(other.inputId, receipt.inputId);
  const store = aide.session("inbox").conversations;
  await seedInput(store, "observation", { origin: "source", originId: SOURCES.environments.id, text: "部署镜像已变化" },
    { phase: "done", quietReason: "Not relevant" });
  assert.equal(store.resource("inbox")!.status.messages.length, 2, "Only the two replies are stored as Messages");
  assert.equal(store.resource("inbox")!.spec.inputIds.length, 3);
  const before = conversationView(aide, "inbox");
  assert.equal(before.blocks.filter((block) => block.type === "input").length, 3);
  await aide.close(); aide = new Aide(root, options, pino({ level: "silent" }));
  assert.deepEqual(conversationView(aide, "inbox"), before);
  await web({ id: "next", sessionId: "inbox", text: "继续处理" }); await aide.settled();
  const history = JSON.parse(prompts.at(-1)!.split("\nRecent conversation: ")[1]!) as Array<{ role: string; text: string }>;
  assert.ok(history.some((item) => item.role === "user" && item.text === "Web 用户交代"));
  assert.ok(history.some((item) => item.role === "user" && item.text === "Lark 用户补充"));
  assert.ok(history.some((item) => item.role === "source" && item.text === "部署镜像已变化"));
  assert.ok(history.some((item) => item.role === "aide" && item.text === "处理完成"));
});
