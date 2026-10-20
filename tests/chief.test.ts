import "./pi-memory-fixture.ts";
import { resolveChiefConfig } from "../src/host/harness/chief/config.ts";
import { conversationView } from "../src/channel/view.ts";
import { loadConfig } from "../src/config.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { INPUT_TYPE, digest, type InputSpec, type InputStatus } from "../plugins/personal/chief-model.ts";
import { createHarnessAdapter } from "../src/host/harness/registry.ts";
import { LarkChannel } from "../src/channel/lark.ts";
import { fakeOptions } from "./fake-harness.ts";
import { SessionStore } from "../src/host/store/store.ts";
import { SOURCE_TYPE } from "../plugins/personal/source.ts";

const log = pino({ level: "silent" });
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await Bun.sleep(10); }
  assert.fail("Timed out waiting for Chief state");
}

test("Chief accepts duplicate input once, answers without Work, isolates conversations and never replays a failed turn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-chief-"));
  const prompts: string[] = [];
  let calls = 0;
  const options = fakeOptions({ chief: async (prompt) => { calls++; if (prompt.includes('"text":"fail"')) throw new Error("Disconnected"); return "直接回答"; },
    execute: async () => { throw new Error("Unexpected Work"); } }, root, prompts);
  let aide = new Aide(root, options, log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const input = { id: "one", sessionId: "me", conversationId: "me", text: "private-information" };
  const [first, duplicate] = await Promise.all([aide.receive(input), aide.receive(input)]);
  assert.equal(first.id, duplicate.id);
  await aide.settled();
  assert.equal(calls, 1);
  assert.equal(aide.works().length, 0);
  assert.deepEqual(aide.messages().map((m) => m.text), ["private-information", "直接回答"]);
  await aide.receive({ ...input, sessionId: "other", conversationId: "other", text: "hello" }); await aide.settled();
  assert.doesNotMatch(prompts[1]!, /private-information/);
  await aide.receive({ ...input, id: "failed", text: "fail" }); await aide.settled();
  assert.match(aide.messages().at(-1)!.text, /本次处理未完成/);
  await aide.close(); aide = new Aide(root, options, log); await aide.start();
  await aide.receive({ ...input, id: "failed", text: "fail" }); await aide.settled();
  assert.equal(calls, 3);
  assert.equal(aide.works().length, 0);
});

test("real Source -> Pi Chief -> Lark confirm/ask -> Work -> Pi, with durable discovery and released model turns", { timeout: 30_000 }, async (t) => {
  const root = process.env.AIDE_CHIEF_TEST_ROOT ?? mkdtempSync(join(tmpdir(), "aide-chief-pi-"));
  const agentDir = join(root, "pi"); mkdirSync(agentDir, { recursive: true });
  const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
  const configPath = join(root, "config.yaml");
  const conversationId = "lark:cli_fixture:oc_me";
  writeFileSync(configPath, JSON.stringify({ harnesses: { chief: { model: { provider: "fixture", id: "test-model" } } }, connectors: { environments: { dev: { kind: "kubernetes", kubeconfig: "~/.kube/dev", namespace: "app", aliases: ["开发"] } }, requirements: { work: { provider: "meego", projectKey: "project", categories: ["story"], userKeys: ["user-me"] } } }, plugins: { personal: {
    watches: [{ id: "mine", source: "work", sessionId: conversationId, intervalMs: 30_000, repositories: [{ forge: "github.com", path: "compforge/aide" }] }] } } }));
  const record = { work_item_id: "123", name: "实现需求", work_item_status: "进行中", current_status_operator: [{ user_key: "user-me", name: "Me" }], updated_at: "2026-10-18", description: "给 aide 加一个功能" };
  writeFileSync(join(bin, "meegle"), `#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.includes("config") ? "project.example.com" : { data: [${JSON.stringify(record)}] }));\n`, { mode: 0o755 });
  const previous = { path: process.env.PATH, connectors: process.env.AIDE_CONFIG };
  process.env.PATH = `${bin}:${previous.path}`; process.env.AIDE_CONFIG = configPath;
  // Bun's default child environment is its startup snapshot. Exercise production startup with config already present.
  if (!process.env.AIDE_CHIEF_TEST_ROOT) {
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.filename, "--test-name-pattern", "real Source"], {
        env: { ...process.env, AIDE_CHIEF_TEST_ROOT: root }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      assert.equal(code, 0, stdout + stderr);
    } finally {
      process.env.PATH = previous.path;
      if (previous.connectors === undefined) delete process.env.AIDE_CONFIG; else process.env.AIDE_CONFIG = previous.connectors;
      rmSync(root, { recursive: true, force: true });
    }
    return;
  }
  let modelCalls = 0;
  const toolsSeen: string[] = [];
  const prompts: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const request = JSON.parse(body); prompts.push(request.messages);
    let tool: { name: string; args: unknown } | undefined;
    let text = "";
    switch (modelCalls++) {
      case 0: tool = { name: "list_environments", args: {} }; break;
      case 1: tool = { name: "read_environment", args: { name: "开发" } }; break;
      case 2: tool = { name: "read_requirement", args: { source: "work", category: "story", id: "123" } }; break;
      case 3: tool = { name: "list_work", args: {} }; break;
      case 4: tool = { name: "confirm", args: { title: "新需求", prompt: "发现你名下的新需求，需要我开始实现吗？" } }; break;
      case 5: tool = { name: "create_work", args: { kind: "task", title: "未确认的工作", instruction: "This must be rejected while waiting for confirmation", trigger: null } }; break;
      case 6: text = "等待你的确认"; break;
      case 7: text = "已保留需求信息，暂不开始实现。"; break;
      case 8: tool = { name: "ask", args: { title: "开发范围", prompt: "在哪个工作目录开发？" } }; break;
      case 9: text = "等待目录"; break;
      case 10: tool = { name: "create_work", args: { kind: "task", title: "实现需求", instruction: `在 ${root} 实现 requirement work/story/123; repository github.com/compforge/aide`, trigger: null } }; break;
      case 12: tool = { name: "dismiss_observation", args: { reason: "已有工作完成，不需要再次打扰用户" } }; break;
      case 13: text = "This internal summary must not be delivered"; break;
      default: text = "已交办实现，我会跟进结果。";
    }
    if (tool) toolsSeen.push(tool.name);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: `r${modelCalls}`, object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: "assistant", ...(tool ? { tool_calls: [{ index: 0, id: `t${modelCalls}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { content: text }) }, null);
    chunk({}, tool ? "tool_calls" : "stop"); res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, api: "openai-completions", apiKey: "fixture",
    models: [{ id: "test-model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
  } } }));
  let executions = 0;
  const coding = fakeOptions({ execute: async (work) => { executions++; assert.match(work.instruction, /work\/story\/123/);
    return { action: "done", summary: "Implemented and verified", notification: "实现已完成", question: null, nextAt: null }; } }, root);
  const config = loadConfig(configPath);
  const chiefConfig = await resolveChiefConfig(config.harnesses.chief, { cwd: root, agentDir, skillPaths: [] });
  const aide: Aide = new Aide(root, { ...coding, config, createAdapter: (target, ports) => target.harness === "chief"
    ? createHarnessAdapter(target, { ...ports, targetConfig: { harness: "chief" },
      chiefSession: aide.chiefSession(target.id, chiefConfig) })
    : coding.createAdapter(target) }, log);
  const sent: string[] = [];
  const bot = new LarkChannel(root, "cli_fixture", aide, { async start() {}, close() {}, async send(_chat, text) { sent.push(text); } }, log);
  t.after(async () => {
    await bot.close(); await aide.close(); server.closeAllConnections(); server.close();
    process.env.PATH = previous.path;
    if (previous.connectors === undefined) delete process.env.AIDE_CONFIG; else process.env.AIDE_CONFIG = previous.connectors;
    rmSync(root, { recursive: true, force: true });
  });
  const receive = (id: string, text: string) => bot.receive({ sender: { sender_type: "user" }, message: { message_id: id, chat_id: "oc_me", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) } });
  await aide.start();
  await until(() => aide.questions().some((q) => q.request.status === "pending")).catch((error) => {
    const sessions = new SessionStore(root); const session = sessions.openSession(sessions.listSessions()[0]!.aideSessionId);
    console.error({ modelCalls, inputs: aide.session(conversationId).store.conversations.inputs(), log: readFileSync(join(session.dir, "session.log"), "utf8") });
    throw error;
  });
  assert.match(JSON.stringify(prompts[2]), /~\/.kube\/dev/);
  const questionId = "message:" + aide.questions()[0]!.request.messageId;
  const pendingQuestion = conversationView(aide, conversationId).blocks.find((block) => block.id === questionId)!;
  assert.equal(pendingQuestion.type, "question"); assert.equal(pendingQuestion.status, "pending");
  assert.ok(pendingQuestion.group_id);

  assert.equal(executions, 0); assert.equal(aide.works().length, 0);
  assert.ok(aide.invocations().every((item) => item.phase === "completed"), "Pi must release its turn before waiting for the user");
  receive("decline", "拒绝"); await bot.deliver();
  assert.match(sent[0]!, /新需求/); assert.equal(sent.length, 1, "Chief's intermediate final text must not become a duplicate question");
  await bot.dispatch();
  await until(() => aide.messages().some((m) => m.text === "已保留需求信息，暂不开始实现。"));
  assert.match(JSON.stringify(prompts[7]), /declined/);
  const completedView = conversationView(aide, conversationId);
  const answeredQuestion = completedView.blocks.find((block) => block.id === questionId)!;
  assert.equal(answeredQuestion.type, "question"); assert.equal(answeredQuestion.status, "answered");
  const finalReply = completedView.blocks.find((block) => block.type === "message" && block.role === "aide" && block.group_id === answeredQuestion.group_id)!;
  assert.equal(finalReply.content, "已保留需求信息，暂不开始实现。");
  assert.deepEqual(completedView.blocks.filter((block) => block.type === "message" && block.role === "aide" && block.group_id === finalReply.group_id).map((block) => block.content), [finalReply.content]);

  assert.equal(aide.works().length, 0);
  receive("decline", "拒绝"); await bot.dispatch();
  assert.equal(modelCalls, 8, "Duplicate answers cannot become fresh user commands");
  receive("start", "现在开始实现"); await bot.dispatch();
  await until(() => aide.questions().some((q) => q.request.status === "pending"));
  const secondQuestion = conversationView(aide, conversationId).blocks.filter((block) => block.type === "question");
  assert.deepEqual(secondQuestion.map((block) => block.status), ["answered", "pending"]);
  assert.notEqual(secondQuestion[0]!.group_id, secondQuestion[1]!.group_id);
  receive("directory", root); await bot.dispatch();
  await until(() => aide.works()[0]?.status === "done"); await aide.settled();
  await bot.deliver();
  assert.equal(executions, 1);
  assert.deepEqual(toolsSeen, ["list_environments", "read_environment", "read_requirement", "list_work", "confirm", "create_work", "ask", "create_work"]);
  assert.equal(aide.works()[0]!.conversationId, conversationId);
  assert.ok(sent.includes("实现已完成"));
  const discoveries = aide.session(conversationId).store.conversations.inputs().filter((item) => item.spec.origin === "source");
  assert.equal(discoveries.length, 1);
  assert.equal(discoveries[0]!.status.phase, "done");
  assert.equal(aide.session(conversationId).store.conversations.input(digest([conversationId, "decline"]))!.spec.replyTo,
    aide.questions()[0]!.request.messageId);
  const source = aide.session(conversationId).store.resources.list(SOURCE_TYPE)[0]!;
  const sessions = new SessionStore(root);
  const poll = () => aide.session(conversationId).plugins.enqueue({ aideSessionId: sessions.listSessions()[0]!.aideSessionId, pluginInstanceId: "personal", namespace: "v1",
    resourceApiVersion: SOURCE_TYPE.apiVersion, resourceKind: SOURCE_TYPE.kind, resourceId: source.metadata.name });
  await poll();
  assert.equal(modelCalls, 12, "Unchanged observations must not call the model again");
  writeFileSync(join(bin, "meegle"), `#!/usr/bin/env node\nconsole.log(JSON.stringify({ data: [${JSON.stringify({ ...record, updated_at: "2026-10-19" })}] }));\n`, { mode: 0o755 });
  await poll();
  await until(() => aide.session(conversationId).store.conversations.inputs().some((item) => item.status.phase === "done" && !!item.status.quietReason));
  await bot.deliver();
  assert.equal(executions, 1);
  assert.ok(!aide.messages().some((m) => m.text.includes("internal summary")));
  assert.ok(!sent.some((text) => text.includes("internal summary")));
});
