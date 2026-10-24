import { historyBlocks } from "../src/channel/reply-layout.ts";
import { larkAddress, webAddress } from "../src/channel/address.ts";
import { fixtureIncoming } from "./address-fixture.ts";
import { iconFor } from "@compforge/aide-plugin";
import { type InputSpec } from "../plugins/personal/input/model.ts";
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
import { httpChannel } from "../src/api/index.ts";
import { topicView, type TopicView } from "../src/channel/view.ts";
import { topicPatches } from "../src/api/stream.ts";
import type { HarnessEventSink } from "../src/host/harness/adapter.ts";
import { fakeOptions } from "./fake-harness.ts";
import { seedInput } from "./topic-fixture.ts";

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
  const aide = new Aide(root, { ...options, createAdapter(target, ports) {
    const adapter = options.createAdapter(target);
    const open = adapter.create.bind(adapter), send = adapter.prompt.bind(adapter);
    let sink: HarnessEventSink;
    adapter.create = async (...args) => { sink = args[1]; return open(...args); };
    adapter.prompt = async (ref, input) => { emitters.set(ports.scope.resourceRef!.name, { sink, turnId: input.invocationId }); return send(ref, input); };
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
  async function connect(topicId: string) {
    const controller = new AbortController(); connections.push(controller);
    const response = await fetch(`${base}/stream?topicId=${topicId}`, { signal: controller.signal });
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const views: TopicView[] = [];
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
          snapshot = applyPatch(snapshot, event);
          views.push(structuredClone(snapshot) as TopicView);
        }
      }
    })().catch((error) => { if (!controller.signal.aborted) throw error; });
    return { views, events, close: async () => { controller.abort(); await reading; } };
  }
  assert.equal((await fetch(base + "/stream")).status, 400);
  assert.equal((await fetch(base + "/stream?topicId=a", { headers: { origin: "https://foreign.test" } })).status, 403);
  const first = await connect("a");
  await until(() => first.views.length > 0);
  assert.equal(first.events[0]!.op, "start");
  assert.deepEqual(first.views[0], { version: "1.0", biz: "aide.topic", blocks: [], meta: { topic_id: "a", context: null, activity: null } });
  const accepted = await fetch(base + "/messages", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "a1", topicId: "a", text: "查看资料", channelId: "forged-channel" }) });
  assert.equal(accepted.status, 200);
  await aide.receive(fixtureIncoming({ channelId: "web", id: "b1",  topicId: "b", text: "另一会话的私有内容" }));
  const firstKey = aide.personal.topics.resource("a")!.metadata.name;
  const secondKey = aide.personal.topics.resource("b")!.metadata.name;
  await until(() => emitters.has(firstKey) && emitters.has(secondKey));
  const runningView = topicView(aide, "a");
  const runningInput = runningView.blocks.find((block) => block.type === "input")!;
  assert.ok(runningView.meta.activity);
  assert.equal(runningInput.group_id, runningView.meta.activity!.id);
  for (const phase of ["queued", "running"]) {
    const history = historyBlocks(runningView.blocks.map((block) => block.type === "input" ? { ...block, status: phase } : block), runningView.meta.activity!);
    assert.ok(history.some((block) => block.id === runningInput.id), "Input remains visible while queued and running");
    assert.ok(!history.some((block) => block.type === "execution" && block.group_id === runningView.meta.activity!.id));
  }
  const { sink, turnId } = emitters.get(firstKey)!;
  const other = emitters.get(secondKey)!;
  other.sink({ kind: "agent_thought_chunk", invocationId: other.turnId, payload: { messageId: "thought-b", content: { type: "text", text: "另一会话的思考" } } });
  sink({ kind: "agent_thought_chunk", invocationId: turnId, payload: { messageId: "thought-a", content: { type: "text", text: "先检查资料" } } });
  sink({ kind: "tool_call_update", invocationId: turnId, payload: { toolCallId: "read-a", title: "read", status: "in_progress", rawInput: { path: "/tmp/README" } } });
  sink({ kind: "agent_message_chunk", invocationId: turnId, payload: { messageId: "text-a", content: { type: "text", text: "正在整理" } } });
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
  assert.equal(aide.outputs().filter((message) => message.role === "aide").length, 0);
  sink({ kind: "agent_message_chunk", invocationId: turnId, payload: { messageId: "text-a", content: { type: "text", text: "重点" } } });
  await until(() => first.events.some((event) => event.op === "append"));
  assert.equal(first.views.at(-1)!.blocks.at(-1)!.content, "正在整理重点");
  await first.close();
  sink({ kind: "agent_message_chunk", invocationId: turnId, payload: { messageId: "text-a", content: { type: "text", text: "，请稍候" } } });
  const second = await connect("a");
  await until(() => second.views.length > 0);
  assert.equal(second.events[0]!.op, "start");
  assert.equal(second.views[0]!.blocks.at(-1)!.content, "正在整理重点，请稍候");
  release(); await aide.settled();
  await until(() => second.views.at(-1)?.meta.activity === null && second.views.at(-1)!.blocks.find((block) => block.type === "input")?.status === "done" && second.views.at(-1)!.blocks.filter((block) => block.type === "message").length === 1);
  assert.equal(second.views.at(-1)!.blocks.filter((block) => block.role === "aide").length, 1);
  assert.equal(second.views.at(-1)!.blocks.filter((block) => block.type === "message").at(-1)!.content, "最终答复");
  const completed = second.views.at(-1)!;
  const context = aide.topics.resource("a")!.status;
  assert.deepEqual(completed.meta.context, { summary: context.summary, recent: context.recent });
  assert.equal(completed.blocks.find((block) => block.type === "execution")!.status, "completed");
  const groupId = completed.blocks.find((block) => block.type === "execution")!.group_id;
  assert.ok(groupId, "Execution grouping must use durable Input ownership");
  assert.equal(completed.blocks.find((block) => block.role === "aide")!.group_id, groupId);
  assert.equal(completed.blocks.filter((block) => block.type === "input").length, 1);
  assert.equal(completed.blocks.find((block) => block.role === "user")!.group_id, groupId);
  assert.equal(completed.blocks.find((block) => block.role === "user")!.origin, "channel");
  assert.equal(completed.blocks.find((block) => block.role === "user")!.inputId, aide.personal.topics.inputs("a")[0]!.metadata.name);
  assert.equal(completed.blocks.find((block) => block.type === "execution")!.harness, "chief");
  assert.equal(completed.blocks.find((block) => block.type === "thought")!.content, "先检查资料");
  assert.equal(completed.blocks.find((block) => block.type === "tool")!.detail, "/tmp/README");
  assert.doesNotMatch(JSON.stringify(completed), /另一会话/);
  const refreshed = await connect("a");
  await until(() => refreshed.views.length > 0);
  assert.deepEqual(refreshed.views[0], completed);
  await refreshed.close();
  assert.equal(aide.works().length, 0);
  const messages = aide.outputs.bind(aide);
  aide.outputs = () => { throw new Error("projection unavailable"); };
  try {
    await until(() => second.events.at(-1)?.op === "end");
    assert.deepEqual(second.events.slice(-2).map((event) => event.op), ["error", "end"]);
    assert.equal(second.views.at(-1)!.meta.error!.code, "view_failed");
    assert.equal((await fetch(base + "/stream?topicId=a")).status, 500);
  } finally { aide.outputs = messages; }
  await second.close();
  await aide.receive(fixtureIncoming({ channelId: "web", id: "a2",  topicId: "a", text: "再聊一个问题" }));
  await aide.settled();
  const later = topicView(aide, "a");
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
    const restored = topicView(reopened, "a");
    assert.deepEqual(restored.blocks.filter(b => b.type === "input" || b.type === "message"), later.blocks.filter(b => b.type === "input" || b.type === "message"));
    assert.equal(restored.blocks.filter(b => b.type === "execution" || b.parent_id).length, 0, "Native execution history is not replayed by Aide");
    assert.doesNotMatch(JSON.stringify(topicView(reopened, "a")), /另一会话/);
  } finally { await reopened.close(); }
});

test("AgentUE reducer reconstructs growing, corrected and removed progress without duplicated text", () => {
  const emitter = new PatchEmitter();
  const initial: TopicView = { version: "1.0", biz: "aide.topic", meta: { topic_id: "a", context: null, activity: null },
    blocks: [{ id: "output:answer", type: "text", content: "整理" }] };
  let previous: TopicView | undefined;
  let snapshot = {};
  for (const next of [initial,
    { ...initial, meta: { ...initial.meta, context: { summary: "当前话题", recent: [{ at: "2026-10-23T08:00:00Z", text: "确认当前结论" }] } } },
    { ...initial, meta: { ...initial.meta, context: { summary: "修订后的话题", recent: [{ at: "2026-10-23T09:00:00Z", text: "补充待办依据" }] } } },
    { ...initial, blocks: [{ id: "output:answer", type: "text" as const, content: "整理重点" }] },
    { ...initial, blocks: [{ id: "output:answer", type: "text" as const, content: "已完成" }] },
    { ...initial, blocks: [] }]) {
    for (const event of topicPatches(emitter, previous, next)) snapshot = applyPatch(snapshot, event);
    assert.deepEqual(snapshot, next);
    previous = next;
  }
});


test("Web exposes failed consumption on the Input without sending an automatic warning", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-web-failed-reply-"));
  const aide = new Aide(root, fakeOptions({
    chief: async () => { throw new Error("controlled model failure"); },
    execute: async () => { throw new Error("No Work expected"); },
  }, root), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive(fixtureIncoming({ channelId: "web", id: "failed-reply",  topicId: "failed", text: "检查展示故障" }));
  await aide.settled();
  const view = topicView(aide, "failed");
  const reply = view.blocks.find((block) => block.type === "input")!;
  assert.equal(reply.status, "failed");
  assert.equal(reply.group_id, aide.personal.topics.inputs("failed")[0]!.consumption.executionId);
  assert.ok(aide.invocations().some((invocation) => invocation.executionId === reply.group_id));
  assert.match(reply.content, /检查展示故障/);
  assert.ok(!view.blocks.some((block) => block.role === "aide"));
});


test("Source receipts expose original evidence before processing and remain visible after quiet consumption and restart", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-web-source-inputs-"));
  const options = fakeOptions({ async execute() { throw new Error("No Work expected"); } }, root);
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const store = aide.personal.topics;
  await assert.rejects(store.submit("missing-origin", { origin: "source", text: "缺少来源身份" } as InputSpec), /originId/);
  assert.equal(store.inputStore.get("missing-origin"), undefined);
  const observation = { type: "workload.changed", environment: "test", namespace: "vke-system", changes: [
    { before: { kind: "Deployment", name: "sandbox-server", generation: 1129 }, after: { kind: "Deployment", name: "sandbox-server", generation: 1130 } },
  ] };
  await seedInput(store, "environment", { topicId: "inbox", origin: "source", originId: SOURCES.environments.id, text: "test / vke-system：Deployment sandbox-server generation 1129 → 1130", observation }, { phase: "done", result: { summary: "No delegated work" } });
  await seedInput(store, "mention", { topicId: "inbox", origin: "source", originId: SOURCES.lark.id, text: "Lark 群内 @：请确认发布窗口", observation: {
    provider: "lark", kind: "mention", message: { id: "om_example", content: "请确认发布窗口" }, context: { messages: [{ content: "完整上下文" }] },
  } });
  await seedInput(store, "failed", { topicId: "inbox", origin: "source", originId: SOURCES.requirements.id, text: "其它 Source 的原始输入" }, { phase: "failed" });
  await seedInput(aide.personal.topics, "private", { topicId: "other", origin: "source", originId: "personal.environments", text: "另一会话的私有输入" });
  const view = topicView(aide, "inbox");
  const receipts = view.blocks.filter((block) => block.type === "input");
  assert.equal(receipts.length, 3);
  assert.equal(new Set(receipts.map((block) => block.id)).size, 3);
  const environment = receipts.find((block) => block.inputId === "environment")!;
  assert.equal(environment.origin, "source");
  assert.equal(environment.originId, SOURCES.environments.id);
  assert.equal(environment.icon, SOURCES.environments.icon);
  assert.equal(environment.label, SOURCES.environments.label);
  assert.equal(environment.status, "done", "Historical facts stay visible after their invocation completes");
  assert.match(environment.content, /Deployment sandbox-server/);
  assert.deepEqual(JSON.parse(environment.detail!.split("\n\nObservation:\n")[1]!.split("\n\n")[0]!), observation);
  const mention = receipts.find((block) => block.inputId === "mention")!;
  assert.equal(mention.status, "queued");
  assert.equal(mention.icon, SOURCES.lark.icon);
  assert.equal(receipts.find((block) => block.inputId === "failed")!.icon, SOURCES.requirements.icon);
  assert.equal(mention.content, "Lark 群内 @：请确认发布窗口");
  assert.match(mention.detail!, /完整上下文/);
  assert.equal(receipts.find((block) => block.inputId === "failed")!.status, "failed");
  assert.match(receipts.find((block) => block.inputId === "failed")!.detail!, /其它 Source 的原始输入/);
  assert.doesNotMatch(JSON.stringify(view), /另一会话/);
  assert.equal(aide.outputs().length, 0, "Showing Input facts must not manufacture outbound messages");
  // Close without starting a Runner: queued and consumed receipts both reconstruct directly from persisted facts.
  await aide.close(); aide = new Aide(root, options, pino({ level: "silent" }));
  assert.deepEqual(topicView(aide, "inbox"), view);
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
    async execute() { throw new Error("No Work expected"); } }, root, [], root, "bot");
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const web = bindChannelInput(CHANNELS.web, (input) => aide.receive(input));
  const lark = bindChannelInput(CHANNELS.lark, (input) => aide.receive(input));
  const input = { id: "same-external-id", topicId: "inbox", source: webAddress("inbox"), text: "Web 用户交代" };
  const receipt = await web(input); await aide.settled();
  assert.deepEqual(await web(input), receipt);
  const other = await lark({ ...input, source: larkAddress("bot", "chat"), text: "Lark 用户补充" }); await aide.settled();
  assert.notEqual(other.inputId, receipt.inputId);
  const store = aide.personal.topics;
  await seedInput(store, "observation", { topicId: "inbox", origin: "source", originId: SOURCES.environments.id, text: "部署镜像已变化" },
    { phase: "done", result: { summary: "Not relevant" } });
  assert.equal(store.outputs("inbox").length, 2, "Only the two replies are stored as Messages");
  assert.equal(store.inputs("inbox").length, 3);
  const before = topicView(aide, "inbox");
  assert.equal(before.blocks.filter((block) => block.type === "input").length, 3);
  await aide.close(); aide = new Aide(root, options, pino({ level: "silent" }));
  assert.deepEqual(topicView(aide, "inbox").blocks.filter(b => b.type === "input" || b.type === "message"),
    before.blocks.filter(b => b.type === "input" || b.type === "message"));
  await web({ id: "next", topicId: "inbox", source: webAddress("inbox"), text: "继续处理" }); await aide.settled();
  const history = aide.personal.topics.inputs("inbox").map((i) => ({ role: i.spec.origin === "channel" ? "user" : "source", text: i.spec.text }));
  assert.doesNotMatch(prompts.at(-1)!, /Recent topic:/, "Warm native history is not injected again");
  assert.ok(history.some((item) => item.role === "user" && item.text === "Web 用户交代"));
  assert.ok(history.some((item) => item.role === "user" && item.text === "Lark 用户补充"));
  assert.ok(history.some((item) => item.role === "source" && item.text === "部署镜像已变化"));
  assert.ok(aide.outputs().some((item) => item.text === "处理完成"));
});
