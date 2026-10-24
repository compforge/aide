import { HarnessCalls } from "../src/host/harness/calls.ts";
import { personalExecution } from "../plugins/personal/execution-context.ts";
import { say, SayInputSchema } from "../plugins/personal/output/action.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Verb } from "../src/host/plugin/verb.ts";
import { HarnessFixtures } from "./harness-fixture.ts";
import { TopicStore, seedInput } from "./topic-fixture.ts";
import { ReconcileCapacity } from "../src/reconcile/queue.ts";
import { emptyReconcileSnapshot } from "../src/host/plugin/reconcile-snapshot.ts";
import { createPluginVerbs } from "../src/plugin-context.ts";

test("say persists an independent scoped Output and validates Input ownership", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-say-"));
  const session = new HarnessFixtures(root).create({ id: "owner", cwd: root });
  const topics = new TopicStore(session);
  await seedInput(topics, "tick", {  topicId: "private", origin: "source", originId: "personal.environments", text: "review" });
  await topics.archive("other", []);
  const verb = new Verb({ actions: { "test/say": async (context, input) => { const { text } = SayInputSchema.parse(input); const association = personalExecution(context); if (!association.topicId) throw new Error("Missing topic"); return topics.say(association.topicId, association.inputId, text); } }, capacity: new ReconcileCapacity(1) });
  t.after(async () => { verb.close(); await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  const context = { pluginInstanceId: "test", namespace: "v1" as const, executionId: "exec", attributes: { topicId: "private", inputId: "tick" } };
  await verb.beginRemote(context);
  const verbs = createPluginVerbs(context, (scope, request) => verb.invoke(scope, request));
  const result = await say(verbs, { text: "可以继续了" });
  assert.equal(result.state, "success");
  assert.equal(topics.get("private")!.outputs.length, 1);
  assert.equal(topics.get("private")!.outputs[0]!.text, "可以继续了");
  assert.equal(session.projection.approvals.size, 0);
  assert.equal(topics.input("tick")!.consumption.phase, undefined);
  assert.equal((await verb.invoke({ ...context, attributes: { ...context.attributes, topicId: "other" } }, { verb: "action", name: "say", input: { text: "wrong scope" } })).state, "failure");
  assert.equal((await verb.invoke({ ...context, attributes: { inputId: "tick" } }, { verb: "action", name: "say", input: { text: "no scope" } })).state, "failure");
  await assert.rejects(say(verbs, { text: " " }));
  assert.equal((await verb.invoke({ ...context, attributes: { topicId: "private" } }, { verb: "action", name: "say", input: { text: "standalone message" } })).state, "success");
  assert.equal(new TopicStore(session).get("private")!.outputs.length, 2);
  verb.endRemote(context.executionId);
});

/** @case Direct Harness dispatch retains deadlines and shutdown cancellation without a business approval gate. */
test("Harness timeout and Host shutdown settle the caller and cancel execution without replay", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-harness-deadline-"));
  const storage = new HarnessFixtures(root), session = storage.create({ id: "owner", cwd: root });
  const dispatched: string[] = [], cancelled: string[] = [];
  const verb = new Verb({ capacity: new ReconcileCapacity(1),
    harness: new HarnessCalls({ records: session, harnesses: () => [{ id: "codex" }], defaultHarness: "codex",
    enqueueHarnessInvocation: (request) => { dispatched.push(request.invocationId); },
    cancelHarnessInvocation: (id) => { cancelled.push(id); return "queued"; } }) });
  t.after(async () => { verb.close(); await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  const scope = { pluginInstanceId: "test", namespace: "v1" as const, executionId: "timeout", resourceRef: { apiVersion: "test.dev/v1", kind: "Work", namespace: "v1" as const, name: "one", uid: "one" } };
  await verb.beginRemote(scope);
  assert.deepEqual(await verb.invoke(scope, { verb: "harness", input: {
    title: "deadline", prompt: "work", timeoutMs: 20,
  } }), { state: "timeout" });
  assert.equal(dispatched.length, 1);
  assert.deepEqual(cancelled, dispatched);
  verb.endRemote(scope.executionId);

  const shutdown = { ...scope, executionId: "shutdown" };
  await verb.beginRemote(shutdown);
  const pending = verb.invoke(shutdown, { verb: "harness", input: {
    title: "shutdown", prompt: "work", timeoutMs: 10_000,
  } });
  await Promise.resolve();
  verb.failAll("Host shutdown");
  assert.deepEqual(await pending, { state: "failure", error: "Host shutdown" });
  assert.equal(dispatched.length, 2);
  assert.deepEqual(cancelled, dispatched);
  assert.equal(session.projection.approvals.size, 0);
  const terminal = verb.listHarnessInvocations();
  assert.deepEqual(terminal.map((item) => item.phase), ["cancelled", "failed"]);
  verb.failOrphans();
  assert.deepEqual(verb.listHarnessInvocations(), terminal);
  assert.equal(dispatched.length, 2);
});

test("Interruption before Harness creation prevents later actions in that execution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-interrupt-before-harness-"));
  const session = new HarnessFixtures(root).create({ id: "owner", cwd: root });
  let dispatched = 0, messages = 0;
  const verb = new Verb({ actions: { "test/say": async () => { messages++; return { outputId: "unexpected" }; } },
    capacity: new ReconcileCapacity(1),
    harness: new HarnessCalls({ records: session, harnesses: () => [], enqueueHarnessInvocation: () => { dispatched++; } }) });
  t.after(async () => { verb.close(); await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  const scope = { pluginInstanceId: "test", namespace: "v1" as const, executionId: "cancel-before-start" };
  await verb.beginRemote(scope);
  verb.interruptExecution(scope.executionId);
  const verbs = createPluginVerbs(scope, (scope, request) => verb.invoke(scope, request));
  assert.deepEqual(await verbs.harness({ title: "late", prompt: "Must not run", timeoutMs: 1000 }), { state: "dismissed" });
  assert.deepEqual(await say(verbs, { text: "late message" }), { state: "dismissed" });
  assert.equal(dispatched, 0); assert.equal(messages, 0); assert.equal(session.projection.approvals.size, 0);
  verb.endRemote(scope.executionId);
});
