import { InputAttention } from "../plugins/personal/input/model.ts";
import { inputJob } from "../plugins/personal/observation/job.ts";
import { PiObservations, ObservationConfigSchema } from "../agents/pi/observation.ts";
import { readObservation } from "@compforge/agent-pi/observation";
import { inspect, type ModelCall, type ToolCall } from "@compforge/agent-observation";
import { readdirSync } from "node:fs";
import type { ReadBackground } from "../agents/background.ts";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { PiAdapter } from "../src/host/harness/pi/adapter.ts";
import { createRouteAgent } from "../agents/route/agent.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import personalDefinitions from "../plugins/personal/definitions.ts";
import { fixtureAddress } from "./address-fixture.ts";
import { fixtureIncoming } from "./address-fixture.ts";
import { personalAdmission } from "../plugins/personal/admission.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { openPersonCatalog } from "../plugins/personal/person/catalog.ts";
import { LOCAL_ME } from "../plugins/personal/person/model.ts";
import type { Persons } from "../plugins/personal/person/service.ts";
import { memoryAgentDir } from "./pi-memory-fixture.ts";
import { Aide } from "../src/app.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { TopicStore } from "./topic-fixture.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { resolvePiConfig, type PiModelConfigInput, type PiConfig } from "../src/host/harness/pi/config.ts";
import { createPiAgent } from "../agents/pi/agent.ts";
import { createChiefAgent } from "../agents/chief/agent.ts";
import { WorkService } from "../plugins/personal/work.ts";
import { Store } from "../plugins/personal/store.ts";
import { HarnessFixtures } from "./harness-fixture.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createHarnessAdapter } from "../src/host/harness/registry.ts";
import type { HarnessEvent, HarnessSessionReference } from "../src/host/harness/adapter.ts";

type Reply = { text: string; stop?: string; thought?: string; pause?: Promise<void> } | { tool: string; args: unknown; pause?: Promise<void> } | { error: true } | { hold: true };

function messageText(content: unknown): string {
  return typeof content === "string" ? content : (content as Array<{ text?: string }>).map(p => p.text ?? "").join("\n");
}

/** Real Pi SDK and HTTP protocol; only the remote model is scripted. No external credentials or network. */
async function setup(t: TestContext, respond: (request: Record<string, unknown>, index: number) => Reply, harness: "pi" | "chief" | "route" = "pi", model: PiModelConfigInput = { provider: "fixture", id: "test-model" }, sharedPersons?: Persons, background?: ReadBackground, captureRequests = false) {
  const root = mkdtempSync(join(tmpdir(), "aide-pi-sdk-"));
  const personFile = join(root, "PERSON.md");
  const requests: Record<string, unknown>[] = [];
  const requestHeaders: IncomingHttpHeaders[] = [];
  const held = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    try {
      const request = JSON.parse(body) as Record<string, unknown>;
      requests.push(request); requestHeaders.push(req.headers);
      const reply = respond(request, requests.length - 1);
      if ("hold" in reply) { held.add(res); res.on("close", () => held.delete(res)); return; }
      if ("error" in reply) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "scripted model failure" } })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({
        id: `reply-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "test-model",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      if ("thought" in reply) chunk({ role: "assistant", reasoning_content: reply.thought }, null);
      chunk({ role: "assistant", ...("tool" in reply ? { content: "我来处理。", tool_calls: [{ index: 0,
        id: `tool-${requests.length}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } : { content: reply.text }) }, null);
      if ("pause" in reply) await reply.pause;
      chunk({}, "tool" in reply ? "tool_calls" : reply.stop ?? "stop");
      res.end("data: [DONE]\n\n");
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const agentDir = join(root, "pi"); mkdirSync(agentDir);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-only", headers: { "x-provider": "snapshot" },
    models: [{ id: "test-model", headers: { "x-model": "snapshot" }, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
  } } }));
  const sessions = new HarnessFixtures(root);
  const catalog = openPersonCatalog(root, { identities: [LOCAL_ME] }, pino({ level: "silent" }), () => {});
  const persons = sharedPersons ?? catalog.persons;
  await persons.initialize();
  const session = sessions.create({ cwd: root });
  const resources = new PluginResourceStore({ home: session.home, pluginInstanceId: "personal" });
  resources.storage.register("personal", personalDefinitions);
  const store = new Store(resources, createResourceClient(resources, undefined, undefined, personalAdmission(new InputStore(root), new OutputStore(root))), new TopicStore(session));
  const work = new WorkService(store, "me", pino({ level: "silent" }));
  const inputs = { cwd: root, agentDir, model };
  const observation = new PiObservations(join(root, "observations"), ObservationConfigSchema.parse({ captureRequests }), pino({ level: "silent" }));
  const config: typeof inputs & { config: PiConfig } = { ...inputs, config: { ...await resolvePiConfig({ ...inputs, ...(harness === "chief" ? { skillPaths: [] } : {}) }), observation } };
  const events: HarnessEvent[] = [];
  let binding: HarnessSessionReference | undefined;
  let finished: (() => void) | undefined;
  let native: AgentSession | undefined;
  const adapter = createHarnessAdapter({ id: "assistant", harness }, {
    targetConfig: { harness }, openApproval: async () => { throw new Error("Unexpected interaction"); },
    piSession: async (input) => (native = await createPiAgent({ ...config, ...input, background })),
    routeSession: (input) => createRouteAgent({ ...config, ...input, port: { async route(value) { return value; }, topics() { return { topics: [], nextOffset: null }; }, input() { return {}; } } }),
    chiefSession: (input) => createChiefAgent({ ...config, ...input, work, persons }),
  });
  const eventsOf: import("../src/host/harness/adapter.ts").HarnessEventSink = (event) => {
    events.push(event);
    session.appendEvent({ ...event, source: { type: "harness", harnessName: "assistant" }, harness, harnessName: "assistant", runtimeId: "main" });
    if (event.kind === "state_update" && event.payload.state === "idle") finished?.();
  };
  const reference: import("../src/host/harness/adapter.ts").SessionReferenceSink = value => { binding = value; };
  const open = () => binding
    ? adapter.resume({ cwd: root, sessionId: binding.identity.id }, eventsOf, reference)
    : adapter.create({ cwd: root }, eventsOf, reference);
  let ref = await open();
  assert.equal(adapter.harness, harness);
  assert.equal(ref.harness, harness);
  const sessionFile = (await SessionManager.listAll(join(agentDir, "sessions"))).find(s => s.id === binding!.identity.id)!.path;
  const nativeRoot = join(agentDir, "sessions");
  assert.ok(relative(nativeRoot, sessionFile).length > 0);
  assert.ok(!relative(nativeRoot, sessionFile).startsWith(".."));
  assert.notEqual(dirname(sessionFile), session.dir);
  assert.equal(existsSync(join(root, "pi-sessions")), false);
  assert.equal(existsSync(join(root, "chief-sessions")), false);
  t.after(async () => {
    await adapter.close(ref);
    for (const response of held) response.destroy();
    server.closeAllConnections(); server.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function run(text: string, turnId: string) {
    const terminal = new Promise<void>((resolve) => { finished = resolve; });
    const receipt = await adapter.prompt(ref, { invocationId: turnId, messageId: `user-${turnId}`, blocks: [{ type: "text", text }] });
    assert.deepEqual(receipt, { accepted: true, effective: "new_turn" });
    await terminal;
    return session.summarizeInvocation(turnId);
  }
  return { work, config, observation, session, adapter, events, requests, requestHeaders, run, personFile, persons, native: () => native!, ref: () => ref, binding: () => binding!,
    reopen: async () => { await adapter.close(ref); ref = await open(); return ref; } };
}

test("Replay loadout rejects an invented call to a disabled native tool", { timeout: 20_000 }, async t => {
  const { restrictSession } = await import("../scripts/lark-replay/run.ts");
  const fixture = await setup(t, (_request, index) => index === 0
    ? { tool: "write", args: { path: "forbidden.txt", content: "must not be written" } }
    : { text: "Denied tool acknowledged" });
  restrictSession(fixture.native());
  await fixture.run("Attempt the disabled tool", "restricted");
  assert.equal(existsSync(join(fixture.config.cwd, "forbidden.txt")), false);
  assert.match(JSON.stringify(fixture.requests.at(-1)!.messages), /not found|not available|Unknown tool/i);
  assert.ok((fixture.requests[0]!.tools as unknown[] | undefined)?.length === 0 || fixture.requests[0]!.tools === undefined);
  writeFileSync(join(fixture.config.cwd, "AGENTS.md"), "ancestor-context-must-not-leak");
  const isolated = await createPiAgent({ ...fixture.config, config: { ...fixture.config.config, loadContextFiles: false } });
  try { assert.doesNotMatch(isolated.systemPrompt, /ancestor-context-must-not-leak/); }
  finally { isolated.dispose(); }
});

test("Replay SDK groups roots and routes subsequent source input to the new root", { timeout: 45_000 }, async t => {
  const { replay } = await import("../scripts/lark-replay/run.ts");
  const fixture = await setup(t, request => {
    const messages = request.messages as Array<{ role: string; content: unknown }>;
    const last = messages.at(-1)!;
    if (JSON.stringify(messages).includes("You are Weave")) {
      if (last.role !== "tool") return { tool: "list_topics", args: {} };
      const value = JSON.parse(messageText(last.content));
      if (value.items?.length >= 2) return { tool: "group_topics", args: {
        topics: value.items.map((item: { uid: string; version: string }) => ({ uid: item.uid, version: item.version })),
        name: "Related fixture evidence", summary: "Both source observations retained",
      } };
      return { text: "Finished organizing" };
    }
    if (last.role === "tool") return { text: "Handled internally" };
    const activation = messageText(last.content).split("Activation: ").at(-1)?.split("\n")[0];
    if (!activation) throw new Error("No replay Input activation");
    return { tool: "assess_input", args: { inputId: JSON.parse(activation).inputId, summary: "Recorded replay evidence" } };
  });
  const directory = join(fixture.config.cwd, "replay-sdk"); mkdirSync(directory); mkdirSync(join(directory, "workspace"));
  const start = "2026-10-19T00:00:00.000Z", end = "2026-10-19T01:00:00.000Z";
  await replay({ version: 1, collectedAt: end, start, end, identity: { accountId: "cli_test", userId: "ou_me" }, meIds: ["ou_me"],
    messages: ["first", "second", "later"].map((id, n) => ({ id, chatId: n === 1 ? "oc_b" : "oc_a", content: id,
      createdAt: `2026-10-19T00:${String((n + 1) * 10).padStart(2, "0")}:00.000Z`, sender: { id: "ou_peer", type: "user" }, mentions: [], deleted: false })),
    directIds: ["first", "second", "later"], groupIds: [],
    coverage: [
      ...["direct", "group", "sent"].map(operation => ({ operation: operation as "direct" | "group" | "sent", key: "", start, end, complete: true, pages: 1 })),
      ...["oc_a", "oc_b"].map(key => ({ operation: "history" as const, key, start: "2026-10-18T23:55:00.000Z", end, complete: true, pages: 1 })),
    ],
  }, { directory, weave: true, batchSize: 1, timeoutMs: 15_000, revision: "fixture", datasetHash: "fixture", model: fixture.config.config });
  const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
  assert.equal(result.topics.length, 3);
  const root = result.topics.find((topic: { parentRef?: unknown }) => !topic.parentRef);
  const later = result.inputs.find((input: any) => input.input.spec.observation.message.id === "later").input;
  assert.notEqual(later.status.route.result.topics[0].uid, root.uid);
  assert.ok(later.status.assess);
  assert.ok(result.usage.chief.calls > 0); assert.ok(result.usage.weave.calls > 0);
  assert.equal(result.protocolFixture, false);
  assert.equal(result.state, "completed");
});

/** @case Native request wiring keeps all Personal roles separate from Me; scripted replies do not prove semantic compliance. */
test("Personal SDK requests carry assistant policy and refresh human identity independently of agent roles", { timeout: 30_000 }, async t => {
  const { identityBackground } = await import("../agents/personal.ts");
  const { createTaskAgent } = await import("../agents/task/agent.ts");
  const { createRoutineAgent } = await import("../agents/routine/agent.ts");
  const { createWeaveAgent } = await import("../agents/weave/agent.ts");
  const fixture = await setup(t, () => ({ text: "protocol fixture" }), "chief");
  await fixture.run("Direct request to Aide", "identity-chief");
  const chiefRequest = JSON.stringify(fixture.requests.at(-1)!.messages);
  assert.match(chiefRequest, /Human|human served by Aide/);
  assert.match(chiefRequest, /\\"provider\\":\\"web\\"/);
  const background = identityBackground(fixture.persons, () => ({ text: () => "current-resource-marker" }));
  for (const create of [createTaskAgent, createRoutineAgent,
    (options: Parameters<typeof createTaskAgent>[0]) => createWeaveAgent({ ...options, scope: "identity-weave", tools: [] }),
    (options: Parameters<typeof createTaskAgent>[0]) => createRouteAgent({ ...options, port: { route: async value => value, input: () => [], topics: () => [] } }),
  ]) {
    const agent = await create({ ...fixture.config, background });
    try {
      await agent.prompt("Inspect the supplied context only");
      const request = JSON.stringify(fixture.requests.at(-1)!.messages);
      assert.match(request, /independent assistant serving Me/);
      assert.match(request, /Aide's proposal is not Me's preference/);
      assert.match(request, /current-resource-marker/);
      assert.match(request, /Human served by Aide, not the assistant/);
      assert.match(request, /\\"provider\\":\\"web\\"/);
    } finally { agent.dispose(); }
  }
  const me = (await fixture.persons.findIdentity(LOCAL_ME))!;
  const before = await background();
  await fixture.persons.edit(me.metadata.name, me.metadata.uid, me.metadata.resourceVersion, { ...me.spec, name: "Updated human" });
  assert.doesNotMatch(before.text(), /Updated human/);
  assert.match((await background()).text(), /Updated human/);
});

test("Pi streams thought and answer before completion without duplicating the final text", { timeout: 20_000 }, async (t) => {
  let release!: () => void;
  const pause = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const fixture = await setup(t, () => ({ text: "逐步出现的回复", thought: "先查看现有资料", pause }));
  const running = fixture.run("检查流式输出", "streaming");
  try {
    for (let i = 0; i < 200 && !fixture.events.some((event) => event.kind === "agent_message_chunk"); i++) await Bun.sleep(10);
    assert.ok(fixture.events.some((event) => event.kind === "agent_message_chunk"));
    assert.ok(fixture.events.some((event) => event.kind === "agent_thought_chunk"));
    assert.ok(!fixture.events.some((event) => event.kind === "state_update" && event.payload.state === "idle"));
  } finally { release(); }
  assert.equal((await running).finalText, "逐步出现的回复");
  const outputs = [...fixture.session.projection.messages.values()].filter((message) => message.kind === "output");
  assert.equal(outputs.filter((message) => message.role === "agent").length, 1);
  assert.equal(outputs.filter((message) => message.role === "thought").length, 1);
});

test("Pi answers directly without work and resumes its native history", { timeout: 20_000 }, async (t) => {
  const fixture = await setup(t, () => ({ text: "你好，有什么可以帮你？" }));
  assert.equal(existsSync(fixture.personFile), false, "Generic Pi does not create a person profile");
  const emptyId = fixture.binding().identity.id;
  assert.equal((await fixture.reopen()).resumed, true);
  assert.equal(fixture.binding().identity.id, emptyId);
  const summary = await fixture.run("你好", "greeting");

  assert.equal(summary.finalText, "你好，有什么可以帮你？");
  assert.equal(fixture.requestHeaders[0]!["x-provider"], "snapshot");
  assert.equal(fixture.requestHeaders[0]!["x-model"], "snapshot");
  assert.equal(summary.stopReason, "end_turn");
  const definitions = fixture.requests[0]!.tools as { function: { name: string } }[];
  const names = definitions.map((tool) => tool.function.name);
  assert.ok(names.includes("read") && names.includes("bash"));
  assert.ok(!names.some((name) => name.endsWith("_work") || ["ask", "confirm", "list_connectors"].includes(name)));
  assert.doesNotMatch(JSON.stringify(fixture.requests[0]!.messages), /You are Chief|Work tools/);
  assert.ok(!definitions.some((tool) => tool.function.name === "memory_add"));
  assert.deepEqual(fixture.work.list(), []);
  assert.equal((await fixture.run("谢谢", "same-session")).stopReason, "end_turn");
  const identity = fixture.binding().identity.id;
  assert.equal((await fixture.reopen()).resumed, true);
  await fixture.run("刚才说了什么？", "followup");
  assert.equal(fixture.binding().identity.id, identity);
  assert.match(JSON.stringify(fixture.requests[1]!.messages), /你好/);
  const data = { sessionFile: (await SessionManager.listAll(join(fixture.config.agentDir, "sessions"))).find(s => s.id === fixture.binding().identity.id)!.path };
  await assert.rejects(createChiefAgent({ ...fixture.config, sessionFile: data.sessionFile, work: fixture.work }), /does not belong/);
  await assert.rejects(createPiAgent({ ...fixture.config, sessionFile: join(fixture.config.agentDir, "sessions", "missing.jsonl") }), /missing/);
});

test("Chief loads declared skills and excludes ambient Pi skills and packages", { timeout: 20_000 }, async (t) => {
  const fixture = await setup(t, () => ({ text: "configured skill available" }), "chief");
  const declared = join(fixture.config.cwd, "declared", "as-ops");
  const ambient = join(fixture.config.agentDir, "skills", "ambient");
  for (const [path, name] of [[declared, "as-ops"], [ambient, "ambient"]] as const) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} capability marker.\n---\nFull skill body stays on disk.\n`);
  }
  // This missing Git package would cause Pi's normal loader to attempt installation.
  writeFileSync(join(fixture.config.agentDir, "settings.json"), JSON.stringify({
    packages: ["git:example.invalid/unwanted/package"], defaultProvider: "unconfigured-default", defaultModel: "wrong-model",
  }));
  const agent = await createChiefAgent({ ...fixture.config, work: fixture.work, config: await resolvePiConfig({ ...fixture.config, skillPaths: [declared] }) });
  try {
    await agent.bindExtensions({ mode: "rpc" });
    assert.match(agent.systemPrompt, /You are Chief/);
    assert.equal(agent.model?.provider, "fixture");
    assert.equal(agent.model?.id, "test-model");
    assert.match(agent.systemPrompt, /as-ops capability marker/);
    assert.doesNotMatch(agent.systemPrompt, /ambient capability marker|Full skill body stays on disk/);
    await agent.prompt("Verify configured capability.");
    assert.match(JSON.stringify(fixture.requests.at(-1)!.messages), /as-ops capability marker/);
  } finally { await agent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); agent.dispose(); }
  const empty = await createChiefAgent({ ...fixture.config, work: fixture.work });
  try { assert.doesNotMatch(empty.systemPrompt, /ambient capability marker|as-ops capability marker/); }
  finally { await empty.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); empty.dispose(); }
});

test("Chief executes Work and independent Input tools through the SDK and keeps commentary out of finalText", { timeout: 30_000 }, async (t) => {
  let id = "", routineId = "", inputId = "";
  const fixture = await setup(t, (request, index) => {
    if (index === 0) return { tool: "create_input", args: { text: "检查 aide" } };
    if (index === 1) {
      const messages = request.messages as Array<{ role: string; content: unknown }>;
      inputId = JSON.parse(messageText(messages.at(-1)!.content)).inputId;
      assert.ok(inputId);
    }
    const works = fixture.work.list();
    const work = works.find((item) => item.kind === "task");
    const routine = works.find((item) => item.kind === "routine");
    if (work) id = work.id;
    if (routine) routineId = routine.id;
    switch (index - 1) {
      case 0: return { tool: "create_work", args: { kind: "task", title: "检查仓库", instruction: "检查 aide", trigger: null, inputId } };
      case 1: return { tool: "list_work", args: {} };
      case 2: return { tool: "read_work", args: { id } };
      case 3: return { tool: "request_work", args: { workId: id, text: "暂停", action: "pause" } };
      case 4: assert.equal(work?.status, "ready"); return { tool: "create_work", args: {
        kind: "routine", title: "定期检查仓库", instruction: "检查 aide", trigger: { cron: "0 9 * * *", timezone: "UTC", event: null },
      } };
      case 5: assert.notEqual(id, routineId); return { tool: "request_work", args: { workId: routineId, text: "修改名称",
        action: "update", changes: { title: "每天检查仓库" } } };
      case 6: assert.equal(routine?.title, "定期检查仓库"); return { tool: "delete_work", args: { id, revision: 1 } };
      case 7: return { tool: "delete_work", args: { id: routineId, revision: 1 } };
      default: return { text: "已完成创建、查询、更新和删除。" };
    }
  }, "chief");
  const summary = await fixture.run("验证 Work 的增删改查", "crud");
  assert.equal(summary.stopReason, "end_turn");
  assert.equal(summary.finalText, "已完成创建、查询、更新和删除。");
  assert.match(summary.agentText!, /我来处理/);
  assert.deepEqual(summary.toolCalls.map((tool) => tool.status), Array(9).fill("completed"));
  assert.deepEqual(fixture.work.list(), []);
  assert.equal(fixture.events.filter((event) => event.kind === "state_update").length, 1);
  assert.equal((await fixture.reopen()).resumed, true);
  assert.equal((await fixture.run("继续聊天", "chief-resumed")).stopReason, "end_turn");
  const sessionFile = (await SessionManager.listAll(join(fixture.config.agentDir, "sessions"))).find(s => s.id === fixture.binding().identity.id)!.path;
  await assert.rejects(createPiAgent({ ...fixture.config, sessionFile }), /does not belong/);
  await assert.rejects(createChiefAgent({ ...fixture.config, sessionFile,
    scope: "chief:another-resource", work: { ...fixture.work, topicId: "another" } as WorkService }), /does not belong/);
});

test("Pi model failure and cancellation settle once, without a successful final answer", { timeout: 30_000 }, async (t) => {
  let reached!: () => void;
  const pending = new Promise<void>((resolve) => { reached = resolve; });
  const fixture = await setup(t, (_request, index) => {
    if (index === 0) return { error: true };
    reached(); return { hold: true };
  });
  const failed = await fixture.run("失败测试", "failed");
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.finalText, undefined);
  const running = fixture.run("取消测试", "cancelled");
  await pending;
  const rejected = await fixture.adapter.prompt(fixture.ref(), { invocationId: "other", messageId: "other", blocks: [{ type: "text", text: "busy" }] });
  assert.equal(rejected.effective, "rejected");
  await fixture.adapter.abort(fixture.ref());
  const cancelled = await running;
  assert.equal(cancelled.stopReason, "cancelled");
  assert.equal(cancelled.finalText, undefined);
  assert.equal(fixture.events.filter((event) => event.kind === "state_update").length, 2);
});

test("Pi refuses unsupported input before admission and does not promote truncated text to final", { timeout: 20_000 }, async (t) => {
  const fixture = await setup(t, () => ({ text: "未完成的回答", stop: "length" }));
  await assert.rejects(fixture.adapter.prompt(fixture.ref(), { invocationId: "image", messageId: "image",
    blocks: [{ type: "image", data: "AA==", mimeType: "image/png" }] }), /does not support/);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.events.length, 0);
  const summary = await fixture.run("回答被截断", "truncated");
  assert.equal(summary.stopReason, "error");
  assert.equal(summary.finalText, undefined);
  assert.match(summary.agentText!, /未完成的回答/);
});

test("Pi requires startup configuration and Chief requires its bound factory", async (t) => {
  const fixture = await setup(t, () => ({ text: "ready" }));
  const ports = { openApproval: async () => { throw new Error("Unexpected interaction"); } };
  assert.equal(createHarnessAdapter({ id: "plain", harness: "pi" }, { ...ports, targetConfig: { harness: "pi" }, piConfig: fixture.config.config }).harness, "pi");
  assert.throws(() => createHarnessAdapter({ id: "plain", harness: "pi" }, { ...ports, targetConfig: { harness: "pi" } }), /startup-resolved/);
  assert.throws(() => createHarnessAdapter({ id: "chief", harness: "chief" }, {
    ...ports, targetConfig: { harness: "chief" },
  }), /Chief agent factory/);
});

// @case session_native_resume: isolated sessions survive restart and reuse Pi history; cwd changes reset only native bindings.
test("Aide isolates continuous native contexts across topics, restart and recreation", { timeout: 30_000 }, async (t) => {
  const fixture = await setup(t, (request, index) => {
    const messages = request.messages as Array<{role: string; content: unknown}>;
    const activation = messageText(messages.findLast(m => m.role === "user")!.content).split("Activation: ").at(-1)!.split("\n")[0]!;
    const inputId = JSON.parse(activation).inputId;
    return index % 3 === 0 ? { tool: "say", args: { text: `native-response-${index / 3}` } }
      : index % 3 === 1 ? { tool: "assess_input", args: { inputId, summary: "Handled request" } }
      : { text: `Internal summary ${Math.floor(index / 3)}` };
  });
  const home = join(fixture.config.cwd, "aide");
  const log = pino({ level: "silent" });
  let aide: Aide;
  const open = (cwd = fixture.config.cwd) => new Aide(home, { cwd, timezone: "UTC", defaultHarnessConfig: { id: "default", harness: "pi" }, createAdapter: (target, ports) =>
    createHarnessAdapter(target, { ...ports, targetConfig: { harness: target.harness },
      chiefSession: aide.chiefSession(ports.scope, fixture.config.config) }) }, log);
  const send = async (sessionId: string, topicId: string, id: string) => {
    await aide.receive(fixtureIncoming({ channelId: "web",  topicId, id, text: `question-${id}` })); await aide.settled();
    assert.equal(aide.personal.topics.inputs().at(-1)!.consumption.phase, "done");
  };
  const binding = (_sessionId: string, topicId: string) => aide.personal.topics.resource(topicId)!.status.agent!.sessionId!;

  aide = open();
  try {
    assert.equal(aide.runtime.plugins.listInstances().length, 1);
    await send("lark:app:group-a", "lark:app:group-a", "a1");
    const original = binding("lark:app:group-a", "lark:app:group-a");
    await send("lark:app:group-a", "lark:app:group-a", "a2");
    assert.equal(binding("lark:app:group-a", "lark:app:group-a"), original);
    assert.match(JSON.stringify(fixture.requests[3]), /native-response-0/);
    await send("lark:app:group-b", "lark:app:group-b", "b1");
    assert.notEqual(binding("lark:app:group-b", "lark:app:group-b"), original);
    assert.doesNotMatch(JSON.stringify(fixture.requests[6]), /question-a1|native-response-0/);
    await aide.close();
    aide = open(); await aide.start();
    assert.equal(aide.runtime.plugins.listInstances().length, 1);
    await send("lark:app:group-a", "lark:app:group-a", "a3");
    assert.equal(binding("lark:app:group-a", "lark:app:group-a"), original);
    assert.match(JSON.stringify(fixture.requests[9]), /native-response-1/);
    assert.doesNotMatch(JSON.stringify(fixture.requests[9]), /question-b1/);
    assert.equal(aide.outputs().filter((message) => message.topicId === "lark:app:group-a").length, 3);
    await aide.close();
    aide = open(); await aide.start();
    await send("lark:app:group-a", "lark:app:group-a", "a4");
    const beforeDelete = binding("lark:app:group-a", "lark:app:group-a");
    const topic = aide.personal.topics.get("lark:app:group-a")!;
    assert.deepEqual(await aide.deleteTopic(topic.id, topic.revision, aide.personal.topics.resource(topic.id)!.metadata.uid), { deleted: true });
    await aide.settled();
    await send("lark:app:group-a", "lark:app:group-a", "a5");
    assert.notEqual(binding("lark:app:group-a", "lark:app:group-a"), beforeDelete);
    assert.doesNotMatch(JSON.stringify(fixture.requests.at(-1)), /question-a[1-4]|native-response-[0-4]/);
    await aide.close();
    aide = open(); await aide.start();
    await send("lark:app:group-a", "lark:app:group-a", "a6");
    assert.match(JSON.stringify(fixture.requests.at(-1)), /question-a5/);
    assert.doesNotMatch(JSON.stringify(fixture.requests.at(-1)), /question-a[1-4]|native-response-[0-4]/);
  } finally { await aide.close(); }
});

// @case startup_config_snapshot: file changes and SDK refresh cannot change subsequent native sessions.
test("Chief accepts an Aide-only model and freezes configuration across SDK refresh and new sessions", { timeout: 20_000 }, async (t) => {
  const fixture = await setup(t, () => ({ text: "snapshot answer" }), "chief", {
    provider: "fixture", id: "aide-only-model", contextWindow: 64000, maxTokens: 2048, reasoning: false,
  });
  const modelFile = join(fixture.config.agentDir, "models.json");
  assert.doesNotMatch(readFileSync(modelFile, "utf8"), /aide-only-model/);
  assert.equal((await fixture.run("first", "first-config")).finalText, "snapshot answer");
  assert.equal(fixture.requests[0]!.model, "aide-only-model");
  const native = JSON.parse(readFileSync(modelFile, "utf8"));
  native.providers.fixture.headers["x-provider"] = "changed";
  native.providers.fixture.models.push({ id: "aide-only-model", reasoning: true, contextWindow: 32000, maxTokens: 1024 });
  writeFileSync(modelFile, JSON.stringify(native));
  writeFileSync(join(fixture.config.agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "fixture", defaultModel: "test-model", packages: ["git:invalid.example/must-not-install"],
  }));
  await fixture.config.config.modelRuntime.refresh({ allowNetwork: false });
  await fixture.reopen();
  await fixture.run("after config change", "second-config");
  assert.equal(fixture.requests.at(-1)!.model, "aide-only-model");
  assert.equal(fixture.requestHeaders.at(-1)!["x-provider"], "snapshot");
  assert.equal(fixture.config.config.modelRuntime.getModel("fixture", "aide-only-model")!.contextWindow, 64000);
  const fresh = await createChiefAgent({ ...fixture.config, work: fixture.work });
  try { await fresh.prompt("new native session"); assert.equal(fixture.requests.at(-1)!.model, "aide-only-model"); }
  finally { fresh.dispose(); }
  // A new startup can see the changed source. Explicit false/limits still win when supplied.
  const restarted = await resolvePiConfig({ cwd: fixture.config.cwd, agentDir: fixture.config.agentDir, skillPaths: [],
    model: { provider: "fixture", id: "aide-only-model" } });
  assert.equal(restarted.model.contextWindow, 32000);
  assert.equal(restarted.model.reasoning, true);
});

test("restart configuration overrides the restored model without losing topic history or affecting Pi", { timeout: 20_000 }, async (t) => {
  const fixture = await setup(t, () => ({ text: "history retained" }), "chief");
  await fixture.run("remember the original request", "before-restart");
  const previous = fixture.config.config;
  fixture.config.config = await resolvePiConfig({ cwd: fixture.config.cwd, agentDir: fixture.config.agentDir, skillPaths: [],
    model: { provider: "fixture", id: "new-deployment" } });
  await fixture.reopen();
  await fixture.run("continue", "after-restart");
  assert.equal(fixture.requests.at(-1)!.model, "new-deployment");
  assert.match(JSON.stringify(fixture.requests.at(-1)!.messages), /remember the original request/);
  assert.equal(previous.model.id, "test-model");
  assert.equal(previous.modelRuntime.getModel("fixture", "new-deployment"), undefined);
  assert.equal(previous.modelRuntime.getModel("fixture", "test-model")!.maxTokens, 4096);
  // New IDs use SDK defaults, not the old model's maxTokens.
  assert.equal(fixture.config.config.model.maxTokens, 16384);
});

test("an entirely Aide-defined provider performs a real SDK request with explicit credentials", { timeout: 20_000 }, async (t) => {
  const fixture = await setup(t, () => ({ text: "independent provider" }), "chief");
  fixture.config.config = await resolvePiConfig({ cwd: fixture.config.cwd, agentDir: fixture.config.agentDir, skillPaths: [],
    model: { provider: "only-in-aide", id: "deployment", api: "openai-completions",
      baseUrl: fixture.config.config.model.baseUrl, apiKeyEnv: "AIDE_TEST_KEY" }, environment: { AIDE_TEST_KEY: "explicit-test-key" } });
  await fixture.reopen();
  assert.equal((await fixture.run("check", "independent-provider")).finalText, "independent provider");
  assert.equal(fixture.requests.at(-1)!.model, "deployment");
  assert.equal(fixture.requestHeaders.at(-1)!.authorization, "Bearer explicit-test-key");
});

test("Chief profiles people through tools and refreshes shared user corrections every turn", { timeout: 30_000 }, async (t) => {
  const writer = await setup(t, (_request, index) => index === 0
    ? { tool: "read_person", args: { id: me.metadata.name } }
    : index === 1 ? { tool: "summarize_person", args: { id: me.metadata.name, uid: me.metadata.uid, version: me.metadata.resourceVersion, summary: "Prefers concise Chinese answers; explicit statement, 2026-10-21." } }
    : { text: "已更新" }, "chief");
  const me = (await writer.persons.findIdentity(LOCAL_ME))!;
  const turn = await writer.run("我更喜欢简洁中文，记一下。", "person-write");
  assert.equal(turn.stopReason, "end_turn");
  assert.match((await writer.persons.findIdentity(LOCAL_ME))!.status.summary, /concise Chinese/);
  assert.equal(existsSync(writer.personFile), false);
  const context = (request: Record<string, unknown>) => JSON.stringify(request.messages);
  await writer.run("现在呢", "person-refresh");
  assert.match(context(writer.requests[2]!), /concise Chinese/, "The Person update is visible on the next tool turn of the same invocation");
  assert.match(context(writer.requests.at(-1)!), /concise Chinese/);
  const reader = await setup(t, () => ({ text: "明白" }), "chief", undefined, writer.persons);
  await reader.run("新话题", "shared");
  assert.match(context(reader.requests.at(-1)!), /concise Chinese/);
  const latest = (await writer.persons.findIdentity(LOCAL_ME))!;
  await writer.persons.edit(latest.metadata.name, latest.metadata.uid, latest.metadata.resourceVersion,
    latest.spec, "Prefer detailed explanations for architecture.");
  await reader.run("最新偏好", "corrected");
  assert.match(context(reader.requests.at(-1)!), /detailed explanations/);
  assert.match(context(reader.requests.at(-1)!), /Explicit corrections take priority/);
  assert.equal((await writer.persons.findIdentity(LOCAL_ME))!.status.summary, "Prefer detailed explanations for architecture.");
  assert.doesNotMatch(context(reader.requests.at(-1)!), /concise Chinese/);
  await reader.reopen();
  assert.equal(existsSync(reader.personFile), false);
});

/** @case Hermes tools and policy run inside Chief; native dialogue and persistent memory have independent lifetimes. */
test("Chief uses bundled Hermes memory across fresh native sessions while generic Pi stays unchanged", { timeout: 30_000 }, async (t) => {
  const marker = `AideMemory${Date.now()}`;
  const writer = await setup(t, (_request, index) => index === 0
    ? { tool: "memory_add", args: { target: "user", content: `${marker}: prefers concise Chinese answers.` } }
    : { text: "已记住。" }, "chief");
  const written = await writer.run("Remember my response preference.", "memory-write");
  assert.equal(written.stopReason, "end_turn");
  assert.match(readFileSync(join(memoryAgentDir, "pi-hermes-memory", "USER.md"), "utf8"), new RegExp(marker));
  assert.match(JSON.stringify(writer.requests[0]!.messages), /memory-policy/);
  const names = (writer.requests[0]!.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
  for (const name of ["memory_add", "memory_replace", "memory_remove", "memory_search", "session_search", "create_work"]) assert.ok(names.includes(name), name);
  await writer.adapter.close(writer.ref());

  const reader = await setup(t, (_request, index) => index === 0
    ? { tool: "memory_search", args: { query: marker, target: "user" } }
    : { text: "已找到偏好。" }, "chief");
  assert.notEqual(writer.binding().identity.id, reader.binding().identity.id);
  assert.doesNotMatch(JSON.stringify(reader.requests), /prefers concise Chinese answers/);
  await reader.run("Find my saved response preference.", "memory-read");
  const result = (reader.requests[1]!.messages as { role: string; content: unknown }[]).filter((message) => message.role === "tool");
  assert.match(JSON.stringify(result), new RegExp(marker));
  assert.match(JSON.stringify(result), /prefers concise Chinese answers/);
  assert.equal(reader.work.list().length, 0);
  const router = await setup(t, (_request, index) => index === 0
    ? { tool: "memory_search", args: { query: marker, target: "user" } } : { text: "Retrieved shared preference" }, "route");
  await router.run("Retrieve the shared preference for routing", "route-memory");
  assert.match(JSON.stringify(router.requests[1]!.messages), new RegExp(marker));
});

/** @case Explicit Pi extensions initialize on open and finish shutdown even when startup fails. */
test("Pi adapter completes extension lifecycle and reports startup failures", async (t) => {
  const fixture = await setup(t, () => ({ text: "ok" }));
  for (const fail of [false, true]) {
    const eventsFile = join(fixture.config.cwd, `extension-${fail}.log`);
    const extension = join(fixture.config.cwd, `extension-${fail}.ts`);
    writeFileSync(extension, `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => { appendFileSync(${JSON.stringify(eventsFile)}, "start\\n"); ${fail ? 'throw new Error("controlled extension startup failure");' : ""} });
  pi.on("session_shutdown", async () => { await new Promise(resolve => setTimeout(resolve, 10)); appendFileSync(${JSON.stringify(eventsFile)}, "stop\\n"); });
}`);
    const errors: string[] = [];
    const adapter = createHarnessAdapter({ id: "extensions", harness: "pi" }, {
      targetConfig: { harness: "pi" }, openApproval: async () => { throw new Error("Unexpected interaction"); },
      piSession: (input) => createPiAgent({ ...fixture.config, ...input, extensionPaths: [extension] }),
      log: (entry) => { if (entry.level === "error") errors.push(entry.error?.message ?? entry.message); },
    });
    const open = () => adapter.create({ cwd: fixture.config.cwd }, () => {}, () => {});
    if (fail) {
      await assert.rejects(open(), /Pi extension startup failed.*controlled extension startup failure/);
      assert.ok(errors.some((error) => error.includes("controlled extension startup failure")));
    } else {
      const handle = await open();
      assert.equal(readFileSync(eventsFile, "utf8"), "start\n");
      await adapter.close(handle);
      await adapter.close(handle);
    }
    assert.equal(readFileSync(eventsFile, "utf8"), "start\nstop\n");
  }
});


test("Routine uses its dedicated Pi agent and independently configured package skills", { timeout: 30_000 }, async t => {
  let inputId = "";
  const fixture = await setup(t, (_request, index) => index === 0
    ? { tool: "report_routine", args: { inputIds: [inputId], action: "done", report: "checked" } }
    : { text: "Recorded" });
  const home = join(fixture.config.cwd, "work-home");
  const skill = join(fixture.config.cwd, "capabilities", "as-ops"); mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: fixture-as-ops\ndescription: Inspect environment evidence.\n---\nRead-only environment operations.\n");
  const routineConfig = await resolvePiConfig({ cwd: fixture.config.cwd, agentDir: fixture.config.agentDir,
    model: { provider: "fixture", id: "work-model" }, skillPaths: [join(skill, "SKILL.md")] });
  const aide: Aide = new Aide(home, { cwd: fixture.config.cwd, timezone: "UTC", defaultHarnessConfig: { id: "default", harness: "pi" }, createAdapter: (target, ports) =>
    createHarnessAdapter(target, { ...ports, routineSession: aide.routineSession(ports.scope, routineConfig), targetConfig: { harness: target.harness } }) }, pino({ level: "silent" }));
  t.after(() => aide.close());
  const work = await aide.work("me").create({ kind: "routine", title: "inspect on event", instruction: "Check evidence", trigger: { cron: null, timezone: "UTC", event: "sample" } });
  await aide.event({ id: "sample-1",  topicId: "me", name: "sample", text: "sample" });
  inputId = aide.topics.inputStore.query("handlePending", work.uid!)[0]!.metadata.name;
  await aide.start(); await aide.settled();
  assert.equal(aide.work("me").read(work.id).status, "scheduled");
  const requests = fixture.requests.filter(request => request.model === "work-model");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.match(JSON.stringify(request.messages), /fixture-as-ops/);
    assert.match(JSON.stringify(request.tools), /report_routine/);
    assert.doesNotMatch(JSON.stringify(request.tools), /memory_add|create_work|report_task/);
  }
});

/** @case Native Chief context survives separate invocations and restart; business consumption still requires its tool. */
test("Chief retains native context across acknowledged Inputs and restart", { timeout: 30_000 }, async t => {
  const fixture = await setup(t, request => {
    const messages = request.messages as Array<{ role: string; content: unknown }>;
    const last = messages.at(-1)!;
    if (last.role === "tool") return { text: "Handled internally" };
    const raw = messageText(last.content);
    const activation = raw.split("Activation: ").at(-1)?.split("\n")[0];
    if (!activation) throw new Error("No input activation");
    const inputId = JSON.parse(activation).inputId;
    return { tool: "assess_input", args: { inputId, summary: "Recorded the observation" } };
  });
  const home = join(fixture.config.cwd, "continuous-home");
  let aide: Aide;
  const open = () => new Aide(home, { cwd: fixture.config.cwd, timezone: "UTC", defaultHarnessConfig: { id: "default", harness: "pi" },
    createAdapter: (target, ports) => createHarnessAdapter(target, { ...ports, targetConfig: { harness: target.harness },
      ...(target.harness === "chief" ? { chiefSession: aide.chiefSession(ports.scope, fixture.config.config) } : {}) }) }, pino({ level: "silent" }));
  aide = open();
  try {
    await aide.topics.ensure("me"); await aide.start();
    await aide.topics.submit("first", { topicId: "me", origin: "source", originId: "fixture", text: "remember-unique-evidence" }); await aide.settled();
    assert.deepEqual(aide.topics.get("me")!.pendingInputIds, [], JSON.stringify(fixture.requests.at(-1)));
    await aide.close(); aide = open(); await aide.start();
    const before = fixture.requests.length;
    await aide.topics.submit("second", { topicId: "me", origin: "source", originId: "fixture", text: "followup-evidence" }); await aide.settled();
    assert.deepEqual(aide.topics.get("me")!.pendingInputIds, [], JSON.stringify(fixture.requests.at(-1)));
    assert.match(JSON.stringify(fixture.requests[before]!.messages), /remember-unique-evidence/);
    assert.match(JSON.stringify(fixture.requests[before]!.messages), /followup-evidence/);
    assert.equal(aide.outputs().length, 0);
  } finally { await aide.close(); }
});

/** @case Steer reaches the next native model call without cancelling or opening another invocation. */
test("Pi applies immediate steer at the next safe boundary", { timeout: 20_000 }, async t => {
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const fixture = await setup(t, (_request, index) => ({ text: index ? "Handled urgent input" : "First response", ...(index ? {} : { pause }) }));
  const running = fixture.run("initial input", "continuous");
  for (let i = 0; i < 200 && !fixture.requests.length; i++) await Bun.sleep(10);
  const receipt = await fixture.adapter.steer!(fixture.ref(), { invocationId: "continuous", messageId: "urgent", blocks: [{ type: "text", text: "urgent-update" }] });
  assert.deepEqual(receipt, { accepted: true, effective: "steer" });
  release(); await running;
  assert.equal(fixture.requests.length, 2);
  assert.match(JSON.stringify(fixture.requests[1]!.messages), /urgent-update/);
  assert.ok(fixture.events.some(e => e.kind === "input_delivery_update" && e.payload.messageId === "urgent" && e.payload.state === "applied"));
  assert.equal(fixture.events.filter(e => e.kind === "state_update" && e.payload.state === "idle").length, 1);
});

/** @case The real SDK sends Route policy and zero execution tools, independently of Chief. */
test("Route exposes only routing, catalog and shared-memory retrieval tools", async t => {
  const answer = JSON.stringify({ decisions: [{ inputId: "one", topicUids: [], reason: "unmatched" }] });
  const fixture = await setup(t, request => {
    assert.match(JSON.stringify(request.messages), /You are Route/);
    const names = (request.tools as Array<{ function: { name: string } }>).map(t => t.function.name);
    for (const name of ["route_input", "list_topics", "read_input", "memory_search"]) assert.ok(names.includes(name), name);
    for (const name of ["say", "assess_input", "create_work", "bash", "summarize_person", "memory_add", "memory_replace", "memory_remove"]) assert.equal(names.includes(name), false, name);
    return { text: answer };
  }, "route");
  const result = await fixture.run(JSON.stringify({ inputs: [{ id: "one", text: "event" }], topics: [] }), "route-one");
  assert.equal(result.finalText, answer);
  assert.equal(fixture.adapter.harness, "route");
  assert.equal(fixture.work.list().length, 0);
});

test("Weave uses a dedicated native session and commits grouping through its restricted tools", { timeout: 20_000 }, async t => {
  const { ConfigSchema } = await import("../src/config.ts");
  const { WEAVE_TYPE } = await import("../plugins/personal/weave/model.ts");
  const { understandingVersion } = await import("../plugins/personal/topic/tree.ts");
  let selected: { uid: string; version: string }[] = [];
  const fixture = await setup(t, (request, index) => {
    assert.match(JSON.stringify(request.messages), /You are Weave/);
    const names = (request.tools as Array<{ function: { name: string } }>).map(t => t.function.name).sort();
    assert.deepEqual(names, ["group_topics", "list_topics", "read_topic"]);
    if (index === 0) return { tool: "list_topics", args: {} };
    if (index === 1) return { tool: "group_topics", args: { topics: selected, name: "Deployment investigation", summary: "Related deployment findings" } };
    return { text: "Grouping proposed" };
  });
  const home = join(fixture.config.cwd, "weave-home");
  const aide: Aide = new Aide(home, { cwd: fixture.config.cwd, timezone: "UTC",
    config: ConfigSchema.parse({ plugins: { personal: { weave: { intervalMs: 1000 } } } }),
    defaultHarnessConfig: { id: "default", harness: "pi" },
    createAdapter: (target, ports) => createHarnessAdapter(target, { ...ports, targetConfig: { harness: target.harness },
      weaveSession: aide.weaveSession(ports.scope, fixture.config.config) }),
  }, pino({ level: "silent" }));
  t.after(() => aide.close());
  for (const id of ["deployment", "restart"]) {
    const topic = await aide.topics.ensure(id);
    selected.push({ uid: topic.metadata.uid, version: understandingVersion(topic) });
  }
  await aide.start(); await aide.settled();
  assert.equal(aide.topics.list().filter(t => t.parentRef).length, 2);
  const weave = (await aide.runtime.plugins.resourceClient("personal").list<Record<string, never>, import("../plugins/personal/weave/model.ts").WeaveStatus>(WEAVE_TYPE))[0]!;
  assert.equal(weave.status.agent?.harness, "weave");
  assert.ok(weave.status.agent?.sessionId);
  assert.equal(weave.status.execution, null);
  assert.equal(aide.outputs().length, 0);
});


/** @case Native steer admission and business completion stay in the same invocation through the real Runner and SDK. */
test("Aide steers immediate Input and independently completes both inputs within one Chief invocation", { timeout: 20_000 }, async t => {
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
  const fixture = await setup(t, (_request, index) => index === 0 ? { text: "Inspecting the first input", pause }
    : index === 1 || index === 2 ? { tool: "assess_input", args: { inputId: index === 1 ? "first" : "urgent", summary: "Observation handled without notification" } }
    : { text: "Handled internally" });
  const home = join(fixture.config.cwd, "steer-home");
  const aide: Aide = new Aide(home, { cwd: fixture.config.cwd, timezone: "UTC", defaultHarnessConfig: { id: "default", harness: "pi" },
    createAdapter: (target, ports) => createHarnessAdapter(target, { ...ports, targetConfig: { harness: target.harness },
      chiefSession: aide.chiefSession(ports.scope, fixture.config.config) }) }, pino({ level: "silent" }));
  t.after(async () => { release(); await aide.close(); });
  await aide.topics.ensure("me"); await aide.start();
  const submit = (id: string, attention: InputAttention) => aide.topics.submit(id, { topicId: "me", origin: "source", originId: "fixture", attention, text: id });
  await submit("first", InputAttention.Normal);
  for (let i = 0; i < 200 && !fixture.requests.length; i++) await Bun.sleep(10);
  assert.equal(fixture.requests.length, 1);
  // Concurrent consumption/status writes invalidate ten admission snapshots: exhaust one local retry budget, then requeue.
  const resourceClient = aide.runtime.plugins.resourceClient.bind(aide.runtime.plugins);
  let conflicts = 10;
  t.mock.method(aide.runtime.plugins, "resourceClient", (instance: string) => {
    const client = resourceClient(instance);
    return { ...client, async commit(writes: readonly import("@compforge/aide-plugin").ResourceCommit[]) {
      const admission = writes.find(w => w.operation === "patchStatus" && w.resource.kind === "Topic"
        && ((w.patch as any).execution?.admissionRevision ?? 0) > 0);
      if (admission?.operation === "patchStatus" && conflicts > 0)
        await client.patchStatus(admission.resource, { summary: `Concurrent status ${conflicts--}` });
      return client.commit(writes);
    } };
  });
  await submit("urgent", InputAttention.Immediate);
  const uid = aide.topics.resource("me")!.metadata.uid;
  for (let i = 0; i < 200 && !aide.topics.inputStore.get("urgent")!.status.assess?.executionId; i++) await Bun.sleep(10);
  assert.ok(aide.topics.inputStore.get("urgent")!.status.assess?.executionId);
  assert.equal(conflicts, 0);
  assert.equal(aide.topics.resource("me")!.status.execution!.admissionRevision, 1);
  release(); await aide.settled();
  assert.deepEqual(aide.topics.get("me")!.pendingInputIds, []);
  const first = aide.topics.inputStore.get("first")!.status.assess!;
  const urgent = aide.topics.inputStore.get("urgent")!.status.assess!;
  assert.ok(first.completedAt); assert.ok(urgent.completedAt); assert.equal(first.executionId, urgent.executionId);
  const background = JSON.stringify((fixture.requests[1]!.messages as Array<{ role: string; content: unknown }>).filter(m => m.role === "user" && messageText(m.content).includes("<aide_background")));
  assert.match(background, /Concurrent status 1/, "Chief sees concurrent summary updates at the steer boundary");
  assert.equal(aide.invocations().filter(i => i.topicId === "me").length, 1);
  const state = aide.runtime.executions.view(aide.invocations().map(i => i.invocationId));
  const admitted = [...state.harnessInputs.values()].find(i => i.delivery === "steer")!;
  assert.equal(admitted.deliveryOutcome, "applied");
  assert.equal(aide.outputs().length, 0);
});

/** @case Cancellation settles queued steer explicitly and never leaks it into a later invocation. */
test("Pi cancellation clears unapplied steering before the next invocation", { timeout: 20_000 }, async t => {
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const fixture = await setup(t, (_request, index) => ({ text: "response", ...(index === 0 ? { pause } : {}) }));
  const first = fixture.run("initial", "cancelled-steer");
  for (let i = 0; i < 200 && !fixture.requests.length; i++) await Bun.sleep(10);
  await fixture.adapter.steer!(fixture.ref(), { invocationId: "cancelled-steer", messageId: "queued-urgent", blocks: [{ type: "text", text: "never-applied-marker" }] });
  await fixture.adapter.abort(fixture.ref()); await first; release();
  assert.ok(fixture.events.some(e => e.kind === "input_delivery_update" && e.payload.messageId === "queued-urgent" && e.payload.state === "failed"));
  await fixture.run("new request", "next");
  assert.doesNotMatch(JSON.stringify(fixture.requests.at(-1)!.messages), /never-applied-marker/);
});

/** @case Route validates ownership and current UIDs, then follows up using its own persistent context. */
test("Aide Route commits tool decisions, rejects invented targets and reuses its context for later input", { timeout: 30_000 }, async t => {
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
  let targetUid = ""; let routeCalls = 0;
  const chiefAssessed = new Set<string>();
  const routeRequests: Record<string, unknown>[] = [];
  const fixture = await setup(t, request => {
    const messages = request.messages as Array<{role: string; content: unknown}>;
    const raw = messageText(messages.findLast(m => m.role === "user")!.content);
    const isRoute = JSON.stringify(request.tools).includes('"route_input"');
    if (isRoute) {
      routeRequests.push(request); routeCalls++;
      const inputId = JSON.parse(raw.split("\n").find(line => line.startsWith('{"inputId":'))!).inputId;
      if (routeCalls === 1) return { tool: "route_input", args: { inputId: "not-admitted", topicUids: [targetUid], reason: "invalid" } };
      if (routeCalls === 2) return { tool: "route_input", args: { inputId, topicUids: ["invented-uid"], reason: "invalid" } };
      if (routeCalls === 3) return { tool: "route_input", args: { inputId, topicUids: [targetUid], reason: "same subject" }, pause };
      if (messages.at(-1)!.role === "tool") return { text: "Routed" };
      return { tool: "route_input", args: { inputId, topicUids: [targetUid], reason: "continuing subject" } };
    }
    const ids: string[] = raw.includes("New Input:")
      ? [JSON.parse(raw.split("\n").find(line => line.startsWith('{"inputId":'))!).inputId]
      : JSON.parse(raw.split("Activation: ").at(-1)!.split("\n")[0]!).inputs.map((i: { inputId: string }) => i.inputId);
    const inputId = ids.find(id => !chiefAssessed.has(id));
    if (!inputId) return { text: "Handled" };
    chiefAssessed.add(inputId);
    return { tool: "assess_input", args: { inputId, summary: "Recorded fact" } };
  });
  const home = join(fixture.config.cwd, "route-home");
  const aide: Aide = new Aide(home, { cwd: fixture.config.cwd, timezone: "UTC", defaultHarnessConfig: { id: "default", harness: "pi" },
    createAdapter: (target, ports) => createHarnessAdapter(target, { ...ports, targetConfig: { harness: target.harness },
      ...(target.harness === "route" ? { routeSession: aide.routeSession(ports.scope, fixture.config.config) } : { chiefSession: aide.chiefSession(ports.scope, fixture.config.config) }) }) }, pino({ level: "silent" }));
  t.after(async () => { release(); await aide.close(); });
  targetUid = (await aide.topics.ensure("topic")).metadata.uid;
  await aide.runtime.plugins.resourceClient("personal").patchStatus(aide.topics.resource("topic")!, { summary: "topic-state-one" });
  await aide.start();
  await aide.topics.submit("route-first", { origin: "source", originId: "fixture", text: "subject-one" });
  for (let i = 0; i < 300 && routeCalls < 3; i++) await Bun.sleep(10);
  assert.equal(routeCalls, 3);
  assert.equal(aide.topics.inputStore.get("route-first")!.status.route?.result, undefined);
  await aide.runtime.plugins.resourceClient("personal").patchStatus(aide.topics.resource("topic")!, { summary: "topic-state-two" });
  await aide.topics.submit("route-second", { origin: "source", originId: "fixture", text: "subject-two" });
  for (let i = 0; i < 300 && !aide.topics.inputStore.get("route-second")!.status.route?.executionId; i++) await Bun.sleep(10);
  assert.ok(aide.topics.inputStore.get("route-second")!.status.route?.executionId);
  release(); await aide.settled();
  for (const id of ["route-first", "route-second"]) {
    const input = aide.topics.inputStore.get(id)!;
    assert.ok(input.status.route?.completedAt);
    assert.ok(input.status.route.agent?.sessionId);
    assert.equal(input.status.route.completedBy?.agent.harness, "route");
    assert.ok(input.status.assess?.executionId);
    const assessment = input.status.assess!;
    assert.equal(assessment.completedBy?.agent.harness, "chief"); assert.ok(assessment.completedBy?.toolCallId);
    const job = await inputJob(input, [], agent => fixture.observation.read(fixture.config.cwd, fixture.config.config, agent.sessionId));
    for (const call of [input.status.route.completedBy!, assessment.completedBy!])
      assert.ok(job.nodes.some(n => n.kind === "tool_call" && (n as ToolCall).tool_call_id === call.toolCallId && n.session?.id === call.agent.sessionId));
    assert.doesNotThrow(() => inspect(job));
    assert.ok(input.status.assess!.completedAt);
  }
  const followup = routeRequests.find(r => JSON.stringify(r.messages).includes("subject-two"))!;
  assert.match(JSON.stringify(followup.messages), /subject-one/);
  const context = (request: Record<string, unknown>) => JSON.stringify((request.messages as Array<{ role: string; content: unknown }>).filter(m => m.role === "user" && messageText(m.content).includes("<aide_background")));
  assert.match(context(routeRequests[0]!), /topic-state-one/);
  assert.match(context(followup), /topic-state-two/);
  assert.doesNotMatch(context(followup), /topic-state-one/);
  assert.equal(aide.topics.list().length, 1);
  assert.equal(aide.invocations().filter(i => i.harnessName === "route").length, 1);
});


/** @case Async native input hooks cannot enqueue into the next invocation after this one settles. */
test("Pi waits for in-flight steer admission before releasing a settled binding", { timeout: 20_000 }, async t => {
  let releaseResponse!: () => void, releaseAdmission!: () => void, admissionStarted!: () => void, settled!: () => void;
  const responseGate = new Promise<void>(r => { releaseResponse = r; });
  const admissionGate = new Promise<void>(r => { releaseAdmission = r; });
  const started = new Promise<void>(r => { admissionStarted = r; });
  const nativeSettled = new Promise<void>(r => { settled = r; });
  const fixture = await setup(t, (_request, index) => ({ text: "Finished", ...(index === 0 ? { pause: responseGate } : {}) }));
  const events: HarnessEvent[] = [];
  const adapter = new PiAdapter({ createSession: async options => {
    const native = await createPiAgent({ ...fixture.config, ...options });
    const steer = native.steer.bind(native);
    native.steer = async (...args) => { admissionStarted(); await admissionGate; return steer(...args); };
    native.subscribe(event => { if (event.type === "agent_settled") settled(); });
    return native;
  } });
  const handle = await adapter.create({ cwd: fixture.config.cwd }, e => events.push(e), () => {});
  t.after(async () => { releaseResponse(); releaseAdmission(); await adapter.close(handle); });
  await adapter.prompt(handle, { invocationId: "first", messageId: "initial", blocks: [{ type: "text", text: "initial" }] });
  for (let i = 0; i < 200 && !fixture.requests.length; i++) await Bun.sleep(10);
  const steering = adapter.steer(handle, { invocationId: "first", messageId: "late", blocks: [{ type: "text", text: "late-admission-marker" }] });
  await started; releaseResponse(); await nativeSettled; await Bun.sleep(10);
  assert.ok(!events.some(e => e.kind === "state_update" && e.payload.state === "idle"));
  releaseAdmission(); await steering;
  for (let i = 0; i < 200 && !events.some(e => e.kind === "state_update"); i++) await Bun.sleep(10);
  assert.ok(events.some(e => e.kind === "input_delivery_update" && e.payload.messageId === "late" && e.payload.state === "failed"));
  await adapter.prompt(handle, { invocationId: "second", messageId: "next", blocks: [{ type: "text", text: "next" }] });
  for (let i = 0; i < 200 && !events.some(e => e.kind === "state_update" && e.invocationId === "second"); i++) await Bun.sleep(10);
  assert.doesNotMatch(JSON.stringify(fixture.requests.at(-1)!.messages), /late-admission-marker/);
});

/** @case Task / Routine use scoped tools, native context and exact handling receipts across Host restart. */
for (const kind of ["task", "routine"] as const)
test(`${kind} native session resumes by ID with scoped reading, say and report tools`, { timeout: 30_000 }, async t => {
  let inputId = "", phase = 0;
  let currentWork: () => import("../plugins/personal/resources.ts").WorkResource;
  const fixture = await setup(t, (request, index) => {
    const names = (request.tools as Array<{ function: { name: string } }>).map(t => t.function.name);
    for (const tool of [`read_${kind}`, "read_input", "read_topic", "say", `report_${kind}`, "upsert_note", `summarize_${kind}`]) assert.ok(names.includes(tool));
    assert.equal(names.includes("create_work"), false);
    switch (index % 8) {
      case 0: return { tool: `read_${kind}`, args: {} };
      case 1: return { tool: "read_input", args: { inputId } };
      case 2: return { tool: "read_topic", args: {} };
      case 3: return { tool: "say", args: { text: `Verified phase ${phase}`, inputIds: [inputId] } };
      case 4: return { tool: "upsert_note", args: { version: currentWork().metadata.resourceVersion,
        ...(currentWork().status.recent[0] ? { noteId: currentWork().status.recent[0]!.id } : {}), text: `Evidence verification phase ${phase}` } };
      case 5: return { tool: `summarize_${kind}`, args: { version: currentWork().metadata.resourceVersion, summary: "Retain verified evidence and actual authorship." } };
      case 6: return { tool: `report_${kind}`, args: { inputIds: [inputId], report: `Verified ${phase}`, action: "done" } };
      default: return { text: "Task progress recorded" };
    }
  });
  const home = join(fixture.config.cwd, "task-native-home");
  let aide: Aide;
  const open = () => new Aide(home, { cwd: fixture.config.cwd, timezone: "UTC", defaultHarnessConfig: { id: "default", harness: "pi" },
    createAdapter: (target, ports) => createHarnessAdapter(target, { ...ports, targetConfig: { harness: target.harness },
      [`${kind}Session`]: kind === "task" ? aide.taskSession(ports.scope, fixture.config.config) : aide.routineSession(ports.scope, fixture.config.config) }) }, pino({ level: "silent" }));
  aide = open();
  try {
    await aide.topics.ensure("me", fixtureAddress("me"));
    const work = await aide.work("me").create({ kind, title: "Inspect evidence", instruction: "unique-work-evidence", trigger: kind === "routine" ? { cron: null, timezone: "UTC", event: "sample" } : null });
    const { workType } = await import("../plugins/personal/resources.ts");
    const get = () => aide.personal.store.resources.get(workType(kind), work.id) as import("../plugins/personal/routine/model.ts").RoutineResource;
    currentWork = get;
    if (kind === "routine") await aide.event({ id: "first",  topicId: "me", name: "sample", text: "initial observation" });
    inputId = aide.topics.inputStore.query("handlePending", work.uid!)[0]!.metadata.name;
    await aide.start(); await aide.settled();
    assert.equal(get().status.status, kind === "task" ? "done" : "scheduled", JSON.stringify(get()));
    const agent = get().status.agent!;
    assert.deepEqual(Object.keys(agent).sort(), ["harness", "sessionId"]);
    assert.equal(agent.harness, kind);
    assert.ok(agent.sessionId);
    assert.equal(aide.outputs().length, 1);
    const output = aide.outputStore.list()[0]!;
    assert.equal(output.spec.producer?.uid, work.uid);
    assert.deepEqual(output.spec.inputIds, [inputId]);
    const fact = aide.topics.inputStore.get(inputId)!;
    assert.deepEqual(output.spec.inputUids, { [inputId]: fact.metadata.uid });
    assert.deepEqual(output.spec.createdBy?.agent, agent);
    const receipt = fact.status.handle![work.uid!]!;
    assert.deepEqual(receipt.agent, agent); assert.deepEqual(receipt.completedBy?.agent, agent);
    const job = await inputJob(fact, [output], ref => fixture.observation.read(fixture.config.cwd, fixture.config.config, ref.sessionId));
    for (const call of [receipt.completedBy!, output.spec.createdBy!])
      assert.ok(job.nodes.some(n => n.kind === "tool_call" && (n as ToolCall).tool_call_id === call.toolCallId));
    assert.doesNotThrow(() => inspect(job));
    if (kind === "routine") assert.equal(aide.topics.inputStore.get(inputId)!.status.assess, undefined);
    await aide.close(); aide = open(); await aide.start();
    const before = fixture.requests.length;
    phase = 1;
    await aide.work("me").requestInput(work.id, { text: "followup-task-evidence" }, "followup");
    inputId = aide.topics.inputStore.query("handlePending", work.uid!)[0]!.metadata.name;
    await aide.settled();
    assert.equal(get().status.status, kind === "task" ? "done" : "scheduled", JSON.stringify(get()));
    assert.deepEqual(get().status.agent, agent);
    assert.match(JSON.stringify(fixture.requests[before]!.messages), /unique-work-evidence/);
    assert.equal(aide.outputs().length, 2);
    assert.equal(get().status.recent.length, 1);
    assert.equal(get().status.recent[0]!.text, "Evidence verification phase 1");
    assert.equal(get().status.summary, "Retain verified evidence and actual authorship.");
    assert.equal(get().status.lastReport!.text, "Verified 1");
    assert.ok(aide.topics.inputStore.list().every(i => i.status.handle?.[work.uid!]?.completedAt));
  } finally { await aide.close(); }
});

/** @case Later Work inputs use native followUp or steer within the admitted invocation, with separate durable receipts. */
for (const kind of ["task", "routine"] as const)
for (const attention of [InputAttention.Normal, InputAttention.Immediate] as const)
test(`${kind} ${attention} Input joins the active native invocation`, { timeout: 20_000 }, async t => {
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
  let firstId = "", laterId = "";
  const fixture = await setup(t, (_request, index) => index === 0 ? { text: "Inspecting", pause }
    : index === 1 ? { tool: `report_${kind}`, args: { inputIds: [firstId, laterId], action: "done", report: "Both inspected" } }
    : { text: "Recorded" });
  const home = join(fixture.config.cwd, "task-active-home");
  const aide: Aide = new Aide(home, { cwd: fixture.config.cwd, timezone: "UTC", defaultHarnessConfig: { id: "default", harness: "pi" },
    createAdapter: (target, ports) => createHarnessAdapter(target, { ...ports, targetConfig: { harness: target.harness },
      [`${kind}Session`]: kind === "task" ? aide.taskSession(ports.scope, fixture.config.config) : aide.routineSession(ports.scope, fixture.config.config) }) }, pino({ level: "silent" }));
  t.after(async () => { release(); await aide.close(); });
  const work = await aide.work("me").create({ kind, title: "Inspect", instruction: "Initial evidence", trigger: kind === "routine" ? { cron: null, timezone: "UTC", event: "sample" } : null });
  if (kind === "routine") await aide.event({ id: "first",  topicId: "me", name: "sample", text: "initial observation" });
  firstId = aide.topics.inputStore.query("handlePending", work.uid!)[0]!.metadata.name;
  await aide.start();
  for (let i = 0; i < 200 && !fixture.requests.length; i++) await Bun.sleep(10);
  assert.equal(fixture.requests.length, 1);
  const resources = aide.runtime.plugins.resourceClient("personal");
  const { workType } = await import("../plugins/personal/resources.ts");
  const { INPUT_TYPE } = await import("../plugins/personal/input/model.ts");
  const { resourceRef } = await import("../plugins/personal/input/state.ts");
  laterId = "later";
  const c = aide.topics.resource("me")!;
  const task = aide.personal.store.resources.get(workType(kind), work.id);
  const at = new Date().toISOString();
  // Seed the result of Chief assessment; the real Work controllers own subsequent admission and execution.
  await resources.commit([
    { operation: "patchStatus", resource: task, patch: { idleSince: null, agentStoppedAt: null, summary: "updated-work-understanding" } },
    { operation: "create", type: INPUT_TYPE, name: laterId,
      spec: { origin: "source", originId: "fixture", attention, text: "later unique evidence" }, status: {
        route: { completedAt: at, result: { topics: [resourceRef(c)], reason: "same topic" } },
        assess: { completedAt: at, result: { summary: "Delegate" } },
        handle: { [work.uid!]: { resource: resourceRef(task), assignedAt: at, request: { action: "context" } } },
      } },
  ]);
  for (let i = 0; i < 200 && !aide.topics.inputStore.get(laterId)?.status.handle?.[work.uid!]?.executionId; i++) await Bun.sleep(10);
  const later = aide.topics.inputStore.get(laterId)!.status.handle![work.uid!]!;
  assert.ok(later.executionId);
  const first = aide.topics.inputStore.get(firstId)!.status.handle![work.uid!]!;
  assert.equal(later.executionId, first.executionId);
  release(); await aide.settled();
  assert.equal(aide.work("me").read(work.id).status, kind === "task" ? "done" : "scheduled");
  for (const id of [firstId, laterId]) assert.ok(aide.topics.inputStore.get(id)!.status.handle![work.uid!]!.completedAt);
  assert.match(JSON.stringify(fixture.requests[1]!.messages), /later unique evidence/);
  const context = (request: Record<string, unknown>) => JSON.stringify((request.messages as Array<{ role: string; content: unknown }>).filter(m => m.role === "user" && messageText(m.content).includes("<aide_background")));
  assert.match(context(fixture.requests[1]!), /updated-work-understanding/);
  assert.match(context(fixture.requests[2]!), /Both inspected/, "A report refreshes the next model turn in the same invocation");
  const state = aide.runtime.executions.view(aide.invocations().map(i => i.invocationId));
  const admitted = [...state.harnessInputs.values()].find(i => i.delivery === (attention === InputAttention.Immediate ? "steer" : "followUp"));
  assert.equal(admitted?.deliveryOutcome, "applied");
});

/** @case Native compaction never persists a truncated checkpoint and can recover on the same session. */
test("Pi native compaction uses model output budget and resumes a valid checkpoint", { timeout: 20_000 }, async t => {
  let summaries = 0;
  const fixture = await setup(t, request => {
    const messages = request.messages as Array<{ role: string; content: unknown }>;
    const isSummary = messages.some(m => messageText(m.content).includes("context summarization assistant"));
    if (!isSummary) return { text: "Handled" };
    summaries++;
    assert.ok(Number(request.max_tokens ?? request.max_completion_tokens) > 800,
      "Summary output must not be capped to 0.8 * reserveTokens");
    return summaries === 1 ? { text: "Incomplete checkpoint", stop: "length" } : { text: "Valid checkpoint: review next input." };
  });
  const native = fixture.native();
  native.settingsManager.applyOverrides({ compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 0 } });
  await fixture.run("Review this input", "first");
  const sessionId = native.sessionId;
  await assert.rejects(native.compact(), /generation hit the token cap/);
  assert.equal(native.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0);
  const compacted = await native.compact();
  assert.match(compacted.summary, /Valid checkpoint/);
  assert.equal(native.sessionManager.getEntries().filter(e => e.type === "compaction").length, 1);
  assert.equal(native.sessionId, sessionId);
  const completedSummaries = summaries;
  assert.ok(completedSummaries >= 2);
  await fixture.reopen();
  assert.equal(fixture.native().sessionId, sessionId);
  assert.equal((await fixture.run("Review a new independent input", "next")).stopReason, "end_turn");
  assert.ok(JSON.stringify(fixture.requests.at(-1)).includes("Valid checkpoint"));
  assert.equal(summaries, completedSummaries, "Resume must reuse the checkpoint");
});

/** @case Business context remains a current user-role prefix across tools, followUp, steer, compaction and resume. */
for (const operation of ["followUp", "steer"] as const) test(`Pi refreshes custom context during ${operation} and rebuilds it after native recovery`, { timeout: 20_000 }, async t => {
  let release!: () => void;
  const pause = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let context: Record<string, string> = { topics: "catalog-version-one", obsolete: "deleted-part-marker" };
  const fixture = await setup(t, (request, index) => {
    if (JSON.stringify(request.messages).includes("context summarization assistant")) {
      assert.doesNotMatch(JSON.stringify(request.messages), /catalog-version|deleted-part-marker/, "Current background is not historical summarization material");
      return { text: "Checkpoint: keep handling inputs." };
    }
    return { text: "Processed", ...(index === 0 ? { pause } : {}) };
  }, "pi", undefined, undefined, () => { const snapshot = { ...context }; return { text: () => JSON.stringify(snapshot) }; });
  const background = (request: Record<string, unknown>) => (request.messages as Array<{ role: string; content: unknown }>).filter(m => messageText(m.content).includes("<aide_background"));
  const running = fixture.run("input one", "live-context");
  for (let i = 0; i < 200 && !fixture.requests.length; i++) await Bun.sleep(10);
  assert.equal(fixture.requests.length, 1);
  assert.match(JSON.stringify(background(fixture.requests[0]!)), /catalog-version-one/);
  assert.ok(background(fixture.requests[0]!).every(m => m.role === "user"));
  context = { topics: "catalog-version-two" };
  const accepted = await fixture.adapter[operation]!(fixture.ref(), { invocationId: "live-context", messageId: "next-input", blocks: [{ type: "text", text: "input two" }] });
  assert.equal(accepted.accepted, true);
  release(); await running;
  const request = fixture.requests[1]!;
  assert.equal(background(request).length, 1);
  assert.match(JSON.stringify(background(request)), /catalog-version-two/);
  assert.doesNotMatch(JSON.stringify(request.messages), /catalog-version-one|deleted-part-marker/);
  assert.equal((request.messages as Array<{ role: string }>).find(m => m.role === "user"), background(request)[0], "Business background precedes input history");
  await fixture.run("same state", "unchanged");
  assert.deepEqual(background(fixture.requests.at(-1)!), background(request), "Unchanged background keeps an identical prefix");
  assert.doesNotMatch(JSON.stringify(fixture.native().sessionManager.getEntries()), /catalog-version|deleted-part-marker/, "Derived material does not accumulate in native history");
  fixture.native().settingsManager.applyOverrides({ compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 0 } });
  await fixture.native().compact();
  const id = fixture.native().sessionId;
  context = { topics: "catalog-version-three-after-restart" };
  await fixture.reopen();
  assert.equal(fixture.native().sessionId, id);
  await fixture.run("after restart", "resumed-context");
  assert.match(JSON.stringify(background(fixture.requests.at(-1)!)), /catalog-version-three-after-restart/);
  assert.doesNotMatch(JSON.stringify(fixture.requests.at(-1)!.messages), /catalog-version-two/);
});

test("Pi refuses stale context when reading current resources fails", { timeout: 20_000 }, async t => {
  let fail = true;
  const fixture = await setup(t, () => ({ text: "Processed" }), "pi", undefined, undefined, () => {
    if (fail) throw new Error("Current resource unavailable");
    return { text: () => "recovered resource" };
  });
  await fixture.run("first", "unavailable");
  assert.equal(fixture.requests.length, 0);
  fail = false;
  await fixture.run("new input", "recovered");
  assert.equal(fixture.requests.length, 1);
  assert.match(JSON.stringify(fixture.requests[0]!.messages), /recovered resource/);
});

/** @case A failed refresh after a tool stops inference; it must not silently continue with old resource facts. */
test("Pi stops the current loop when context cannot refresh between tool turns", { timeout: 20_000 }, async t => {
  let fail = false;
  const fixture = await setup(t, () => {
    fail = true;
    return { tool: "bash", args: { command: "printf fixture" } };
  }, "pi", undefined, undefined, () => {
    if (fail) throw new Error("Resource refresh failed");
    return { text: () => "initial resource state" };
  });
  const result = await fixture.run("Inspect", "refresh-failed");
  assert.equal(fixture.requests.length, 1);
  assert.notEqual(result.stopReason, "end_turn");
});

/** @case Native Session remains authoritative; provider request evidence survives close/resume without copying response bodies. */
test("Pi Observation preserves request Background and stable native links after resume", async t => {
  let background = "current background v1";
  const f = await setup(t, () => ({ text: "native-only answer" }), "pi", { provider: "fixture", id: "test-model" }, undefined,
    async () => ({ text: () => background }), true);
  await f.run("first input", "first");
  const id = f.binding().identity.id;
  const first = await f.observation.read(f.config.cwd, f.config.config, id);
  const models = first.nodes.filter(n => n.kind === "model_call") as ModelCall[];
  assert.equal(models.length, 1);
  assert.match(JSON.stringify(models[0]!.request), /current background v1/);
  assert.match(JSON.stringify(models[0]!.response), /native-only answer/);
  assert.doesNotThrow(() => inspect(first));
  await f.reopen(); background = "current background v2";
  await f.run("followup input", "second");
  const resumed = await f.observation.read(f.config.cwd, f.config.config, id);
  const resumedModels = resumed.nodes.filter(n => n.kind === "model_call") as ModelCall[];
  assert.equal(resumedModels.length, 2); assert.equal(resumedModels[0]!.id, models[0]!.id);
  assert.match(JSON.stringify(resumedModels[1]!.request), /current background v2/);
  assert.equal(readdirSync(f.observation.directory).length, 1);
  const supplement = readObservation(join(f.observation.directory, readdirSync(f.observation.directory)[0]!), id);
  assert.equal(supplement.nodes.some(n => JSON.stringify((n as ModelCall).response ?? {}).includes("native-only answer")), false);
  const native = SessionManager.open(f.native().sessionFile!);
  assert.equal(JSON.stringify(native.getEntries()).includes("current background v2"), false);
});

/** @case Deferred arrivals never enter native queues, but an active Chief may discover and assess them. */
test("Chief can read and assess a late Deferred Input without steer or followUp", { timeout: 20_000 }, async t => {
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
  const fixture = await setup(t, (_request, index) => index === 0 ? { tool: "read_input", args: {}, pause }
    : index === 1 ? { tool: "read_input", args: { inputId: "deferred" } }
    : index === 2 ? { tool: "assess_input", args: { inputId: "deferred", summary: "Relevant observation inspected" } }
    : index === 3 ? { tool: "assess_input", args: { inputId: "first", summary: "Request handled" } }
    : { text: "Handled internally" });
  const home = join(fixture.config.cwd, "deferred-home");
  const aide: Aide = new Aide(home, { cwd: fixture.config.cwd, timezone: "UTC", defaultHarnessConfig: { id: "default", harness: "pi" },
    createAdapter: (target, ports) => createHarnessAdapter(target, { ...ports, targetConfig: { harness: target.harness },
      chiefSession: aide.chiefSession(ports.scope, fixture.config.config) }) }, pino({ level: "silent" }));
  t.after(async () => { release(); await aide.close(); });
  const c = await aide.topics.ensure("me"); await aide.start();
  await aide.topics.submit("first", { topicId: "me", origin: "source", originId: "fixture", attention: InputAttention.Normal, text: "request" });
  for (let i = 0; i < 200 && !fixture.requests.length; i++) await Bun.sleep(10);
  assert.equal(fixture.requests.length, 1);
  await aide.topics.submit("deferred", { topicId: "me", origin: "source", originId: "fixture", attention: InputAttention.Deferred, text: "late-deferred-evidence" });
  for (let i = 0; i < 200 && !aide.topics.inputStore.get("deferred")?.status.route?.completedAt; i++) await Bun.sleep(10);
  const before = aide.topics.inputStore.get("deferred")!.status.assess!;
  assert.equal(before.executionId, undefined);
  assert.equal(aide.topics.resource("me")!.status.execution!.admissionRevision, 0);
  release(); await aide.settled();
  const first = aide.topics.inputStore.get("first")!.status.assess!;
  const deferred = aide.topics.inputStore.get("deferred")!.status.assess!;
  assert.ok(deferred.completedAt); assert.equal(deferred.startedAt, undefined); assert.ok(deferred.completedBy);
  assert.equal(deferred.executionId, undefined, "read-only discovery does not create automatic admission");
  assert.equal(deferred.completedBy?.agent.sessionId, first.completedBy?.agent.sessionId);
  assert.match(JSON.stringify(fixture.requests[2]!.messages), /late-deferred-evidence/);
  assert.equal(aide.invocations().filter(i => i.topicId === "me").length, 1);
  const state = aide.runtime.executions.view(aide.invocations().map(i => i.invocationId));
  assert.ok([...state.harnessInputs.values()].every(i => i.delivery !== "steer" && i.delivery !== "followUp"));
});

/** @case Weave changes resources only; the owning Topic Reconcile sends one native followUp while Chief is busy. */
test("Weave wakes busy root Chief through its Reconcile without moving or claiming Input", { timeout: 20_000 }, async t => {
  const { ConfigSchema } = await import("../src/config.ts");
  const { WEAVE_TYPE } = await import("../plugins/personal/weave/model.ts");
  const { groupTopics } = await import("../plugins/personal/weave/service.ts");
  const { understandingVersion } = await import("../plugins/personal/topic/tree.ts");
  let release!: () => void; const pause = new Promise<void>(resolve => { release = resolve; });
  let aide: Aide;
  const fixture = await setup(t, (_request, index) => {
    if (index === 0) return { text: "Reviewing material", pause };
    if (index === 1) return { tool: "assess_input", args: { inputId: "first", summary: "Reviewed" } };
    if (index === 2) {
      const parent = aide.topics.resource("parent")!, child = aide.topics.resource("child")!;
      return { tool: "summarize_topic", args: { version: parent.metadata.resourceVersion, summary: "Combined understanding",
        absorbed: [{ uid: child.metadata.uid, version: understandingVersion(child) }] } };
    }
    return { text: "Done" };
  });
  aide = new Aide(join(fixture.config.cwd, "weave-notify-home"), { cwd: fixture.config.cwd, timezone: "UTC",
    config: ConfigSchema.parse({ plugins: { personal: { weave: { enabled: false } } } }), defaultHarnessConfig: { id: "default", harness: "pi" },
    createAdapter: (target, ports) => createHarnessAdapter(target, { ...ports, targetConfig: { harness: target.harness }, chiefSession: aide.chiefSession(ports.scope, fixture.config.config) }),
  }, pino({ level: "silent" }));
  t.after(async () => { release(); await aide.close(); });
  const parent = await aide.topics.ensure("parent"), child = await aide.topics.ensure("child");
  const resources = aide.runtime.plugins.resourceClient("personal");
  const weave = await resources.create(WEAVE_TYPE, { name: "global", spec: {}, status: {} });
  const notices: any[] = [];
  const submit = aide.personal.submitTopic.bind(aide.personal);
  t.mock.method(aide.personal, "submitTopic", async (scope: Parameters<typeof submit>[0], args: unknown) => {
    if ((args as any).weaveRevision) notices.push({ scope, args });
    return submit(scope, args);
  });
  await aide.start();
  await aide.topics.submit("first", { topicId: "parent", origin: "source", originId: "fixture", text: "first" });
  for (let n = 0; n < 200 && !fixture.requests.length; n++) await Bun.sleep(10);
  assert.equal(fixture.requests.length, 1);
  await groupTopics(resources, weave, { topics: [{ uid: child.metadata.uid, version: understandingVersion(child) }],
    parent: { uid: parent.metadata.uid, version: understandingVersion(aide.topics.resource("parent")!) } }, 4000);
  for (let n = 0; n < 200 && aide.topics.resource("parent")!.status.notifiedWeaveRevision !== 1; n++) await Bun.sleep(10);
  assert.equal(aide.topics.resource("parent")!.status.notifiedWeaveRevision, 1);
  for (let n = 0; n < 3; n++) await aide.runtime.plugins.enqueue({ pluginInstanceId: "personal", namespace: "v1", resourceApiVersion: parent.apiVersion,
    resourceKind: parent.kind, resourceId: parent.metadata.name });
  await Bun.sleep(100);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].scope.resourceRef.uid, parent.metadata.uid);
  assert.equal(notices[0].scope.controllerName, undefined);
  assert.equal(notices[0].args.operation, "followUp");
  release(); await aide.settled();
  assert.match(JSON.stringify(fixture.requests.at(-1)!.messages), /Topic structure changed through Weave/);
  assert.equal(aide.invocations().filter(i => i.topicId === "parent").length, 1);
  const state = aide.runtime.executions.view(aide.invocations().map(i => i.invocationId));
  assert.equal([...state.harnessInputs.values()].filter(i => i.delivery === "followUp").length, 1);
  assert.ok(aide.topics.inputStore.get("first")!.status.assess?.executionId);
});
