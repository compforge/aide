import { memoryAgentDir } from "./pi-memory-fixture.ts";
import { Aide } from "../src/app.ts";
import { chiefTarget } from "../plugins/personal/chief-model.ts";
import { createResourceClient } from "../src/host/plugin/resource-client.ts";
import { ConversationStore, seedInput } from "./conversation-fixture.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { resolvePiConfig, type PiModelConfigInput } from "../src/host/harness/pi/config.ts";
import { createPiAgent } from "../agents/pi/agent.ts";
import { createChiefAgent } from "../agents/chief/agent.ts";
import { WorkService } from "../plugins/personal/work.ts";
import { Store } from "../plugins/personal/store.ts";
import { SessionStore } from "../src/host/store/store.ts";
import { PluginResourceStore } from "../src/host/plugin/resource.ts";
import { createHarnessAdapter } from "../src/host/harness/registry.ts";
import type { HarnessEvent, HarnessSessionBinding } from "../src/host/harness/adapter.ts";

type Reply = { text: string; stop?: string; thought?: string; pause?: Promise<void> } | { tool: string; args: unknown } | { error: true } | { hold: true };

/** Real Pi SDK and HTTP protocol; only the remote model is scripted. No external credentials or network. */
async function setup(t: TestContext, respond: (request: Record<string, unknown>, index: number) => Reply, harness: "pi" | "chief" = "pi", model: PiModelConfigInput = { provider: "fixture", id: "test-model" }) {
  const root = mkdtempSync(join(tmpdir(), "aide-pi-sdk-"));
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
  const sessions = new SessionStore(root);
  const session = sessions.createSession({ cwd: root });
  const resources = new PluginResourceStore({ session, pluginInstanceId: "personal" });
  const store = new Store(resources, createResourceClient(resources), new ConversationStore(session));
  const work = new WorkService(store, "me", pino({ level: "silent" }));
  const inputs = { cwd: root, agentDir, model };
  const config = { ...inputs, config: await resolvePiConfig({ ...inputs, ...(harness === "chief" ? { skillPaths: [] } : {}) }) };
  const events: HarnessEvent[] = [];
  let binding: HarnessSessionBinding | undefined;
  let finished: (() => void) | undefined;
  const adapter = createHarnessAdapter({ id: "assistant", harness }, {
    targetConfig: { harness }, openInteraction: async () => { throw new Error("Unexpected interaction"); },
    piSession: (input) => createPiAgent({ ...config, ...input }),
    chiefSession: (input) => createChiefAgent({ ...config, ...input, work }),
  });
  const open = () => adapter.open({ cwd: root, ...(binding ? { resumeState: binding.resumeState } : {}) }, (event) => {
    events.push(event);
    session.appendEvent({ ...event, source: { type: "harness", harnessTargetId: "assistant" }, harness, harnessTargetId: "assistant", laneId: "main" });
    if (event.kind === "state_update" && event.payload.state === "idle") finished?.();
  }, (value) => { binding = value; });
  let ref = await open();
  assert.equal(adapter.harness, harness);
  assert.equal(ref.harness, harness);
  const sessionFile = (binding!.resumeState.data as { sessionFile: string }).sessionFile;
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
    const receipt = await adapter.sendTurn(ref, { turnId, messageId: `user-${turnId}`, blocks: [{ type: "text", text }] });
    assert.deepEqual(receipt, { accepted: true, effective: "new_turn" });
    await terminal;
    return session.summarizeTurn(turnId);
  }
  return { work, config, session, adapter, events, requests, requestHeaders, run, ref: () => ref, binding: () => binding!,
    reopen: async () => { await adapter.close(ref); ref = await open(); return ref; } };
}

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
  assert.equal((fixture.binding().resumeState.data as { empty: boolean }).empty, true);
  assert.equal((await fixture.reopen()).resumed, false);
  const summary = await fixture.run("你好", "greeting");
  assert.equal((fixture.binding().resumeState.data as { empty: boolean }).empty, false);
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
  const data = fixture.binding().resumeState.data as { sessionFile: string };
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

test("Chief executes all five Work tools through the SDK and keeps commentary out of finalText", { timeout: 30_000 }, async (t) => {
  let id = "", routineId = "";
  const fixture = await setup(t, (_request, index) => {
    const works = fixture.work.list();
    const work = works.find((item) => item.kind === "task");
    const routine = works.find((item) => item.kind === "routine");
    if (work) id = work.id;
    if (routine) routineId = routine.id;
    switch (index) {
      case 0: return { tool: "create_work", args: { kind: "task", title: "检查仓库", instruction: "检查 aide", trigger: null } };
      case 1: return { tool: "list_work", args: {} };
      case 2: return { tool: "read_work", args: { id } };
      case 3: return { tool: "append_input", args: { workId: id, text: "暂停", action: "pause" } };
      case 4: assert.equal(work?.status, "ready"); assert.equal(work?.inputs[0]?.action, "pause"); return { tool: "create_work", args: {
        kind: "routine", title: "定期检查仓库", instruction: "检查 aide", trigger: { cron: "0 9 * * *", timezone: "UTC", event: null },
      } };
      case 5: assert.notEqual(id, routineId); return { tool: "append_input", args: { workId: routineId, text: "修改名称",
        action: "update", changes: { title: "每天检查仓库" } } };
      case 6: assert.equal(routine?.inputs[0]?.changes?.title, "每天检查仓库"); assert.equal(routine?.title, "定期检查仓库"); return { tool: "delete_work", args: { id, revision: 2 } };
      case 7: return { tool: "delete_work", args: { id: routineId, revision: 2 } };
      default: return { text: "已完成创建、查询、更新和删除。" };
    }
  }, "chief");
  const summary = await fixture.run("验证 Work 的增删改查", "crud");
  assert.equal(summary.stopReason, "end_turn");
  assert.equal(summary.finalText, "已完成创建、查询、更新和删除。");
  assert.match(summary.agentText!, /我来处理/);
  assert.deepEqual(summary.toolCalls.map((tool) => tool.status), Array(8).fill("completed"));
  assert.deepEqual(fixture.work.list(), []);
  assert.equal(fixture.events.filter((event) => event.kind === "state_update").length, 1);
  assert.equal((await fixture.reopen()).resumed, true);
  assert.equal((await fixture.run("继续聊天", "chief-resumed")).stopReason, "end_turn");
  const sessionFile = (fixture.binding().resumeState.data as { sessionFile: string }).sessionFile;
  await assert.rejects(createPiAgent({ ...fixture.config, sessionFile }), /does not belong/);
  await assert.rejects(createChiefAgent({ ...fixture.config, sessionFile,
    work: { ...fixture.work, conversationId: "another" } as WorkService }), /does not belong/);
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
  const rejected = await fixture.adapter.sendTurn(fixture.ref(), { turnId: "other", messageId: "other", blocks: [{ type: "text", text: "busy" }] });
  assert.equal(rejected.effective, "rejected");
  await fixture.adapter.cancel(fixture.ref());
  const cancelled = await running;
  assert.equal(cancelled.stopReason, "cancelled");
  assert.equal(cancelled.finalText, undefined);
  assert.equal(fixture.events.filter((event) => event.kind === "state_update").length, 2);
});

test("Pi refuses unsupported input before admission and does not promote truncated text to final", { timeout: 20_000 }, async (t) => {
  const fixture = await setup(t, () => ({ text: "未完成的回答", stop: "length" }));
  await assert.rejects(fixture.adapter.sendTurn(fixture.ref(), { turnId: "image", messageId: "image",
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
  const ports = { openInteraction: async () => { throw new Error("Unexpected interaction"); } };
  assert.equal(createHarnessAdapter({ id: "plain", harness: "pi" }, { ...ports, targetConfig: { harness: "pi" }, piConfig: fixture.config.config }).harness, "pi");
  assert.throws(() => createHarnessAdapter({ id: "plain", harness: "pi" }, { ...ports, targetConfig: { harness: "pi" } }), /startup-resolved/);
  assert.throws(() => createHarnessAdapter({ id: "chief", harness: "chief" }, {
    ...ports, targetConfig: { harness: "chief" },
  }), /Chief agent factory/);
});

// @case session_native_resume: isolated sessions survive restart and reuse Pi history; cwd changes reset only native bindings.
test("Aide routes stable Sessions and resumes real Chief native context across inputs and restart", { timeout: 30_000 }, async (t) => {
  const fixture = await setup(t, (_request, index) => ({ text: `native-response-${index}` }));
  const home = join(fixture.config.cwd, "aide");
  const log = pino({ level: "silent" });
  let aide: Aide;
  const open = (cwd = fixture.config.cwd) => new Aide(home, { cwd, timezone: "UTC", defaultTarget: { id: "default", harness: "pi" }, createAdapter: (target, ports) =>
    createHarnessAdapter(target, { ...ports, targetConfig: { harness: target.harness },
      chiefSession: aide.chiefSession(target.id, fixture.config.config) }) }, log);
  const send = async (sessionId: string, conversationId: string, id: string) => {
    await aide.receive({ sessionId, conversationId, id, text: `question-${id}` }); await aide.settled();
    assert.equal(aide.findConversation(conversationId)!.conversations.inputs().at(-1)!.status.phase, "done");
  };
  const binding = (sessionId: string, conversationId: string) => {
    const session = new SessionStore(home).openSession(sessionId);
    const target = chiefTarget(conversationId);
    const laneId = aide.findConversation(conversationId)!.conversations.runs(conversationId).find((run) => run.status.laneId)!.status.laneId!;
    return session.meta.lanes[laneId]!.harnessSessions[target]!;
  };
  aide = open();
  try {
    assert.equal(aide.sessions().length, 0);
    await send("feishu:app:group-a", "feishu:app:group-a", "a1");
    const original = binding("feishu:app:group-a", "feishu:app:group-a");
    await send("feishu:app:group-a", "feishu:app:group-a", "a2");
    assert.equal(binding("feishu:app:group-a", "feishu:app:group-a").harnessSessionId, original.harnessSessionId);
    assert.match(JSON.stringify(fixture.requests[1]), /native-response-0/);
    await send("feishu:app:group-b", "feishu:app:group-b", "b1");
    assert.notEqual(binding("feishu:app:group-b", "feishu:app:group-b").harnessSessionId, original.harnessSessionId);
    assert.doesNotMatch(JSON.stringify(fixture.requests[2]), /question-a1|native-response-0/);
    await aide.close();
    aide = open(); await aide.start();
    assert.equal(aide.sessions().length, 2);
    await send("feishu:app:group-a", "feishu:app:group-a", "a3");
    assert.equal(binding("feishu:app:group-a", "feishu:app:group-a").harnessSessionId, original.harnessSessionId);
    assert.match(JSON.stringify(fixture.requests[3]), /native-response-1/);
    assert.doesNotMatch(JSON.stringify(fixture.requests[3]), /question-b1/);
    assert.equal(aide.messages().filter((message) => message.conversationId === "feishu:app:group-a").length, 6);
    await aide.close();
    const cwd = join(fixture.config.cwd, "other-cwd"); mkdirSync(cwd);
    aide = open(cwd); await aide.start();
    assert.equal(binding("feishu:app:group-a", "feishu:app:group-a"), undefined);
    await send("feishu:app:group-a", "feishu:app:group-a", "a4");
    assert.notEqual(binding("feishu:app:group-a", "feishu:app:group-a").harnessSessionId, original.harnessSessionId);
    assert.equal(aide.messages().filter((message) => message.conversationId === "feishu:app:group-a").length, 8);
    const beforeDelete = binding("feishu:app:group-a", "feishu:app:group-a");
    const conversation = aide.findConversation("feishu:app:group-a")!.conversations.get("feishu:app:group-a")!;
    assert.deepEqual(await aide.deleteConversation(conversation.id, conversation.revision, aide.findConversation(conversation.id)!.conversations.resource(conversation.id)!.metadata.uid), { deleted: true });
    await aide.settled();
    await send("feishu:app:group-a", "feishu:app:group-a", "a5");
    assert.notEqual(binding("feishu:app:group-a", "feishu:app:group-a").harnessSessionId, beforeDelete.harnessSessionId);
    assert.doesNotMatch(JSON.stringify(fixture.requests.at(-1)), /question-a[1-4]|native-response-[0-4]/);
    await aide.close();
    aide = open(); await aide.start();
    await send("feishu:app:group-a", "feishu:app:group-a", "a6");
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

test("restart configuration overrides the restored model without losing conversation history or affecting Pi", { timeout: 20_000 }, async (t) => {
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
      targetConfig: { harness: "pi" }, openInteraction: async () => { throw new Error("Unexpected interaction"); },
      piSession: (input) => createPiAgent({ ...fixture.config, ...input, extensionPaths: [extension] }),
      log: (entry) => { if (entry.level === "error") errors.push(entry.error?.message ?? entry.message); },
    });
    const open = () => adapter.open({ cwd: fixture.config.cwd }, () => {}, () => {});
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


test("Task and Routine execute with the default Pi Harness and its configured package skill", { timeout: 30_000 }, async (t) => {
  const outcome = { action: "done", summary: "checked", notification: "verified", question: null, nextAt: null };
  const fixture = await setup(t, () => ({ text: JSON.stringify(outcome) }));
  const home = join(fixture.config.cwd, "work-home");
  const skill = join(fixture.config.cwd, "capabilities", "as-ops"); mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: fixture-as-ops\ndescription: Inspect AgentSphere environment evidence.\n---\nRead-only environment operations.\n");
  const piConfig = await resolvePiConfig({ cwd: fixture.config.cwd, agentDir: fixture.config.agentDir,
    model: { provider: "fixture", id: "work-model" }, skillPaths: [join(skill, "SKILL.md")] });
  const aide = new Aide(home, { cwd: fixture.config.cwd, timezone: "UTC", defaultTarget: { id: "default", harness: "pi" }, createAdapter: (target, ports) =>
    createHarnessAdapter(target, { ...ports, piConfig, targetConfig: { harness: target.harness } }) }, pino({ level: "silent" }));
  t.after(() => aide.close());
  await aide.start();
  await aide.work("me").create({ kind: "task", title: "inspect once", instruction: "Check evidence", trigger: null });
  await aide.settled();
  assert.equal(aide.works()[0]!.status, "done");
  await aide.work("me").create({ kind: "routine", title: "inspect on event", instruction: "Check evidence", trigger: { cron: null, timezone: "UTC", event: "sample" } });
  await aide.event({ id: "sample-1", sessionId: "me", conversationId: "me", name: "sample", text: "sample" });
  await aide.settled();
  assert.equal(aide.works().find((work) => work.kind === "routine")!.status, "scheduled");
  const requests = fixture.requests.filter((request) => request.model === "work-model");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.match(JSON.stringify(request.messages), /fixture-as-ops/);
    assert.doesNotMatch(JSON.stringify(request.tools), /memory_add|create_work/);
  }
  const session = new SessionStore(home).openSession("me");
  assert.equal(session.meta.harnessTargets.default!.harness, "pi");
  assert.ok(Object.values(session.meta.lanes).some((lane) => lane.harnessSessions.default?.harness === "pi"));
});
