import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { createPiAgent } from "../agent/pi/agent.ts";
import { WorkService } from "../plugins/personal/work.ts";
import { Store } from "../plugins/personal/store.ts";
import { SessionStore } from "../src/runtime/store/store.ts";
import { PluginResourceStore } from "../src/runtime/plugin/resource.ts";
import { createHarnessAdapter } from "../src/runtime/harness/registry.ts";
import type { HarnessEvent, HarnessSessionBinding } from "../src/runtime/harness/adapter.ts";

type Reply = { text: string; stop?: string } | { tool: string; args: unknown } | { error: true } | { hold: true };

/** Real Pi SDK and HTTP protocol; only the remote model is scripted. No external credentials or network. */
async function setup(t: TestContext, respond: (request: Record<string, unknown>, index: number) => Reply) {
  const root = mkdtempSync(join(tmpdir(), "aide-pi-sdk-"));
  const requests: Record<string, unknown>[] = [];
  const held = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    try {
      const request = JSON.parse(body) as Record<string, unknown>;
      requests.push(request);
      const reply = respond(request, requests.length - 1);
      if ("hold" in reply) { held.add(res); res.on("close", () => held.delete(res)); return; }
      if ("error" in reply) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "scripted model failure" } })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({
        id: `reply-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "test-model",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      chunk({ role: "assistant", ...("tool" in reply ? { content: "我来处理。", tool_calls: [{ index: 0,
        id: `tool-${requests.length}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } : { content: reply.text }) }, null);
      chunk({}, "tool" in reply ? "tool_calls" : reply.stop ?? "stop");
      res.end("data: [DONE]\n\n");
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const agentDir = join(root, "pi"); mkdirSync(agentDir);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "fixture-only",
    models: [{ id: "test-model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
  } } }));
  const sessions = new SessionStore(root);
  const session = sessions.createSession({ cwd: root });
  const store = new Store(new PluginResourceStore({ session, pluginInstanceId: "personal" }), () => {});
  const work = new WorkService(store, "me", pino({ level: "silent" }));
  const config = { work, cwd: root, agentDir, sessionDir: join(root, "pi-sessions"), model: { provider: "fixture", id: "test-model" } };
  const events: HarnessEvent[] = [];
  let binding: HarnessSessionBinding | undefined;
  let finished: (() => void) | undefined;
  const adapter = createHarnessAdapter({ id: "assistant", harness: "pi" }, {
    targetConfig: { harness: "pi" }, openInteraction: async () => { throw new Error("Unexpected interaction"); },
    piSession: (input) => createPiAgent({ ...config, ...input }),
  });
  const open = () => adapter.open({ cwd: root, ...(binding ? { resumeState: binding.resumeState } : {}) }, (event) => {
    events.push(event);
    session.appendEvent({ ...event, source: { type: "harness", harnessTargetId: "assistant" }, harness: "pi", harnessTargetId: "assistant", laneId: "main" });
    if (event.kind === "state_update" && event.payload.state === "idle") finished?.();
  }, (value) => { binding = value; });
  let ref = await open();
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
  return { work, config, session, adapter, events, requests, run, ref: () => ref, binding: () => binding!,
    reopen: async () => { await adapter.close(ref); ref = await open(); return ref; } };
}

test("Pi answers directly without work and resumes its native history", { timeout: 20_000 }, async (t) => {
  const fixture = await setup(t, () => ({ text: "你好，有什么可以帮你？" }));
  const summary = await fixture.run("你好", "greeting");
  assert.equal(summary.finalText, "你好，有什么可以帮你？");
  assert.equal(summary.stopReason, "end_turn");
  assert.deepEqual(fixture.work.list(), []);
  assert.equal((await fixture.run("谢谢", "same-session")).stopReason, "end_turn");
  const identity = fixture.binding().identity.id;
  assert.equal((await fixture.reopen()).resumed, true);
  await fixture.run("刚才说了什么？", "followup");
  assert.equal(fixture.binding().identity.id, identity);
  assert.match(JSON.stringify(fixture.requests[1]!.messages), /你好/);
  const data = fixture.binding().resumeState.data as { sessionFile: string };
  await assert.rejects(createPiAgent({ ...fixture.config, sessionFile: data.sessionFile,
    work: { ...fixture.work, conversationId: "another" } as WorkService }), /does not belong/);
  await assert.rejects(createPiAgent({ ...fixture.config, sessionFile: join(fixture.config.sessionDir, "missing.jsonl") }), /missing/);
});

test("Pi executes all five Work tools through the SDK and keeps commentary out of finalText", { timeout: 30_000 }, async (t) => {
  let id = "";
  const fixture = await setup(t, (_request, index) => {
    const work = fixture.work.list()[0];
    if (work) id = work.id;
    switch (index) {
      case 0: return { tool: "create_work", args: { kind: "task", title: "检查仓库", instruction: "检查 aide", trigger: null } };
      case 1: return { tool: "list_work", args: {} };
      case 2: return { tool: "read_work", args: { id } };
      case 3: return { tool: "update_work", args: { id, revision: 1, action: "update",
        changes: { kind: "routine", trigger: { cron: "0 9 * * *", timezone: "UTC", event: null } } } };
      case 4: assert.equal(work?.kind, "routine"); return { tool: "delete_work", args: { id, revision: 2 } };
      default: return { text: "已完成创建、查询、更新和删除。" };
    }
  });
  const summary = await fixture.run("验证 Work 的增删改查", "crud");
  assert.equal(summary.stopReason, "end_turn");
  assert.equal(summary.finalText, "已完成创建、查询、更新和删除。");
  assert.match(summary.agentText!, /我来处理/);
  assert.deepEqual(summary.toolCalls.map((tool) => tool.status), Array(5).fill("completed"));
  assert.deepEqual(fixture.work.list(), []);
  assert.equal(fixture.events.filter((event) => event.kind === "state_update").length, 1);
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
