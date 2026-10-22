import { say, SayInputSchema } from "../plugins/personal/output/action.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Verb } from "../src/host/plugin/verb.ts";
import { SessionStore } from "../src/host/store/store.ts";
import { ConversationStore, seedInput } from "./conversation-fixture.ts";
import { ReconcileCapacity } from "../src/reconcile/queue.ts";
import { emptyReconcileSnapshot } from "../src/host/plugin/reconcile-snapshot.ts";
import { createPluginVerbs } from "../src/plugin-context.ts";

test("say persists an independent scoped Output and validates Input ownership", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-say-"));
  const session = new SessionStore(root).createSession({ id: "owner", cwd: root });
  const conversations = new ConversationStore(session);
  await seedInput(conversations, "tick", { sessionId: session.id, conversationId: "private", origin: "source", originId: "personal.environments", text: "review" });
  await conversations.archive("other", []);
  const verb = new Verb({ session, actions: { "test/say": async (context, input) => { const { text } = SayInputSchema.parse(input); if (!context.conversationId) throw new Error("Missing conversation"); return conversations.say(context.conversationId, context.inputId, text); } }, capacity: new ReconcileCapacity(1), snapshot: () => emptyReconcileSnapshot(session.id) });
  t.after(async () => { verb.close(); await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  const context = { aideSessionId: session.id, pluginInstanceId: "test", namespace: "v1" as const, executionId: "exec", conversationId: "private", inputId: "tick" };
  await verb.beginRemote(context);
  const verbs = createPluginVerbs(context, (scope, request) => verb.invoke(scope, request));
  const result = await say(verbs, { text: "可以继续了" });
  assert.equal(result.state, "success");
  assert.equal(conversations.get("private")!.outputs.length, 1);
  assert.equal(conversations.get("private")!.outputs[0]!.text, "可以继续了");
  assert.equal(session.projection.approvals.size, 0);
  assert.equal(conversations.input("tick")!.consumption.phase, undefined);
  assert.equal((await verb.invoke({ ...context, conversationId: "other" }, { verb: "action", name: "say", input: { text: "wrong scope" } })).state, "failure");
  assert.equal((await verb.invoke({ ...context, conversationId: undefined }, { verb: "action", name: "say", input: { text: "no scope" } })).state, "failure");
  await assert.rejects(say(verbs, { text: " " }));
  assert.equal((await verb.invoke({ ...context, inputId: undefined }, { verb: "action", name: "say", input: { text: "standalone message" } })).state, "success");
  assert.equal(new ConversationStore(session).get("private")!.outputs.length, 2);
  verb.endRemote(context.executionId);
});

/** @case Direct Harness dispatch retains deadlines and shutdown cancellation without a business approval gate. */
test("Harness timeout and Host shutdown settle the caller and cancel execution without replay", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-harness-deadline-"));
  const storage = new SessionStore(root), session = storage.createSession({ id: "owner", cwd: root });
  const dispatched: string[] = [], cancelled: string[] = [];
  const verb = new Verb({ session, capacity: new ReconcileCapacity(1),
    snapshot: () => ({ ...emptyReconcileSnapshot(session.id), harnessTargets: [{ id: "codex", harness: "codex" }] }),
    selectedHarnessTargetId: () => "codex",
    enqueueHarnessInvocation: (request) => { dispatched.push(request.invocationId); },
    cancelHarnessInvocation: (id) => { cancelled.push(id); return "queued"; } });
  t.after(async () => { verb.close(); await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  const scope = { aideSessionId: session.id, pluginInstanceId: "test", namespace: "v1" as const, executionId: "timeout" };
  await verb.beginRemote(scope);
  assert.deepEqual(await verb.invoke(scope, { verb: "harness", input: {
    title: "deadline", laneId: "main", prompt: "work", timeoutMs: 20,
  } }), { state: "timeout" });
  assert.equal(dispatched.length, 1);
  assert.deepEqual(cancelled, dispatched);
  verb.endRemote(scope.executionId);

  const shutdown = { ...scope, executionId: "shutdown" };
  await verb.beginRemote(shutdown);
  const pending = verb.invoke(shutdown, { verb: "harness", input: {
    title: "shutdown", laneId: "main", prompt: "work", timeoutMs: 10_000,
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
  const session = new SessionStore(root).createSession({ id: "owner", cwd: root });
  let dispatched = 0, messages = 0;
  const verb = new Verb({ session, actions: { "test/say": async () => { messages++; return { outputId: "unexpected" }; } },
    capacity: new ReconcileCapacity(1), snapshot: () => emptyReconcileSnapshot(session.id),
    enqueueHarnessInvocation: () => { dispatched++; } });
  t.after(async () => { verb.close(); await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  const scope = { aideSessionId: session.id, pluginInstanceId: "test", namespace: "v1" as const, executionId: "cancel-before-start" };
  await verb.beginRemote(scope);
  verb.interruptExecution(scope.executionId);
  const verbs = createPluginVerbs(scope, (scope, request) => verb.invoke(scope, request));
  assert.deepEqual(await verbs.harness({ title: "late", laneId: "main", prompt: "Must not run", timeoutMs: 1000 }), { state: "dismissed" });
  assert.deepEqual(await say(verbs, { text: "late message" }), { state: "dismissed" });
  assert.equal(dispatched, 0); assert.equal(messages, 0); assert.equal(session.projection.approvals.size, 0);
  verb.endRemote(scope.executionId);
});
