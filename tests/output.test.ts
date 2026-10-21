import { larkAddress } from "../src/channel/address.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { OUTPUT_TYPE, type OutputSpec } from "@compforge/aide-plugin";
import { OutputStore } from "../src/host/output/store.ts";
import { outputPrinter } from "../src/host/output/printer.ts";
import { outputView } from "../src/output.ts";
import { SessionStore } from "../src/host/store/store.ts";
import { AideResourceProvider } from "../src/host/plugin/aide-resource.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { ResourceCapacityError, ResourceStorageConfigSchema } from "../src/host/resource/storage.ts";
import { ConversationStore, seedInput, fixtureBatch } from "./conversation-fixture.ts";
import { outputSpec } from "../plugins/personal/output.ts";
import { LarkChannel } from "../src/channel/lark.ts";
import type { LarkTransport } from "../src/channel/lark-client.ts";

async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "aide-output-"));
  const session = new SessionStore(root).createSession({ id: "owner", cwd: root });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  const conversations = new ConversationStore(session), outputs = conversations.outputStore;
  const conversation = await conversations.ensure("topic");
  const provider = new AideResourceProvider({ session, outputs });
  const changes: string[] = [];
  const client = createResourceClient(conversations.resources, (c) => changes.push(c.resource.metadata.name), undefined, provider);
  const spec = (text = "结果"): OutputSpec => outputSpec(conversation, { text, conversationId: "topic" });
  return { root, session, conversations, conversation, outputs, client, changes, spec };
}

/** @case A notification can have no Input; several Outputs can explain the same group of Inputs. */
test("Output persists independent many-to-many associations, immutable content and destination, and a Printer", async (t) => {
  const f = await setup(t);
  const first = f.outputs.create(f.session.id, "one", { ...f.spec("第一条\n完整详情"), inputIds: ["a", "b"] });
  f.outputs.create(f.session.id, "two", { ...f.spec("第二条"), inputIds: ["a", "b"] });
  const proactive = f.outputs.create(f.session.id, "proactive", f.spec("主动提醒"));
  assert.equal(proactive.spec.inputIds, undefined);
  assert.deepEqual(f.outputs.create(f.session.id, "one", first.spec), first);
  assert.throws(() => f.outputs.create(f.session.id, "one", { ...first.spec, text: "修改内容" }), /different content/);
  assert.throws(() => f.outputs.create(f.session.id, "one", { ...first.spec, target: larkAddress("app", "chat") }), /different content/);
  assert.equal(new OutputStore(f.root).list({ conversationUid: f.conversation.metadata.uid }).length, 3);
  assert.equal(first.status.phase, "delivered", "Web publication does not require a reader acknowledgement");
  assert.match(outputPrinter.describe(first), /第一条\n完整详情/);
  assert.equal(outputPrinter.summarize(first), "第一条 完整详情");
  assert.equal((await f.client.list(OUTPUT_TYPE)).length, 3);
  assert.equal((await f.client.get({ ...OUTPUT_TYPE, namespace: "aide-system", name: "one", uid: first.metadata.uid }))?.metadata.uid, first.metadata.uid);
  await assert.rejects(f.client.patchStatus(first, { phase: "pending" }), /Cannot update builtin/);
});

/** @case Atomic publication includes resource CAS, Output admission, quota checks and observer visibility. */
test("Resource commit rolls back result and Output together on validation, conflict or capacity failure", async (t) => {
  const f = await setup(t);
  const type = { apiVersion: "test.dev/v1", kind: "Work" };
  let work = await f.client.create(type, { name: "work", spec: {}, status: { done: false } });
  const write = (name: string, spec: OutputSpec = f.spec()) => ({ operation: "create" as const, type: OUTPUT_TYPE, name, spec });
  let notifications = 0;
  const observed: boolean[] = [];
  f.outputs.subscribe(() => { notifications++; observed.push(f.conversations.resources.get<{}, { done: boolean }>(type, "work").status.done); });
  f.changes.length = 0;
  await assert.rejects(f.client.commit([
    { operation: "patchStatus", resource: work, patch: { done: true } }, write("invalid", { ...f.spec(), text: "" }),
  ]));
  assert.equal(f.conversations.resources.get<{}, { done: boolean }>(type, "work").status.done, false);
  assert.deepEqual(f.changes, []); assert.equal(notifications, 0);
  work = await f.client.patchStatus(work, { done: false });
  await f.client.patchStatus(work, { done: true });
  await assert.rejects(f.client.commit([write("conflicted"), { operation: "patchStatus", resource: work, patch: { done: false } }]), /version conflict/);
  assert.equal(f.outputs.get("conflicted"), undefined);
  assert.equal(f.outputs.storage.hasReceipt("output:conflicted"), false);
  const current = f.conversations.resources.get<{}, { done: boolean }>(type, "work");
  f.outputs.storage.configure(ResourceStorageConfigSchema.parse({ kinds: { "aide.dev/Output": { maxCount: 1 } } }));
  await assert.rejects(f.client.commit([
    { operation: "patchStatus", resource: current, patch: { done: false } }, write("first"), write("second"),
  ]), ResourceCapacityError);
  assert.equal(f.outputs.list().length, 0, "A later write must not evict an earlier write from the same transaction");
  assert.equal(f.conversations.resources.get<{}, { done: boolean }>(type, "work").status.done, true);
  assert.equal(notifications, 0);
  await f.client.commit([{ operation: "patchStatus", resource: current, patch: { done: true } }, write("success")]);
  assert.equal(notifications, 1);
  assert.deepEqual(observed, [true]);
});

test("Pending Output survives quota pressure; delivered unreferenced history is collectable without re-delivery", async (t) => {
  const f = await setup(t);
  f.outputs.storage.configure(ResourceStorageConfigSchema.parse({ kinds: { "aide.dev/Output": { maxCount: 1 } } }));
  const spec: OutputSpec = { ...f.spec(), target: larkAddress("app", "chat") };
  f.outputs.create(f.session.id, "pending", spec);
  assert.throws(() => f.outputs.create(f.session.id, "next", f.spec()), ResourceCapacityError);
  f.outputs.begin("pending");
  assert.equal(f.outputs.get("pending")!.status.attempts, 1);
  f.outputs.delivered("pending");
  f.outputs.create(f.session.id, "next", f.spec());
  assert.equal(f.outputs.get("pending"), undefined);
  assert.throws(() => f.outputs.create(f.session.id, "pending", spec), /already created and reclaimed/);
});

test("say associates optional Inputs and pins Outputs only for the owning Batch, with tool-call idempotency", async (t) => {
  const f = await setup(t);
  for (const id of ["a", "b"]) await seedInput(f.conversations, id, { origin: "channel", originId: "web", text: id, conversationId: "topic" });
  let c = f.conversations.resource("topic")!;
  await f.client.patchStatus(c, { batch: fixtureBatch({ id: "batch", executionId: "execution", phase: "running", inputIds: ["a", "b"] }) });
  const say = (text: string, key: string, inputIds?: string[]) => f.conversations.say("topic", undefined, text, "execution", { idempotencyKey: key, inputIds });
  const first = await say("一起回答", "tool-1", ["a", "b"]);
  assert.deepEqual(await say("一起回答", "tool-1", ["a", "b"]), first);
  await say("补充回答", "tool-2", ["a", "b"]);
  await say("主动提醒", "tool-3");
  assert.equal(f.outputs.list().length, 3);
  await assert.rejects(say("不相关", "tool-4", ["foreign"]), /not attached/);
  c = f.conversations.resource("topic")!;
  assert.equal(c.status.batch!.outputIds.length, 3);
  assert.deepEqual(c.status.pendingInputIds, ["a", "b"], "Saying something does not consume Inputs");
  f.outputs.storage.configure(ResourceStorageConfigSchema.parse({ kinds: { "aide.dev/Output": { maxCount: 3 } } }));
  assert.throws(() => f.outputs.create(f.session.id, "over-capacity", f.spec()), ResourceCapacityError);
  await f.client.patchStatus(c, { batch: null });
  f.outputs.create(f.session.id, "after-handoff", f.spec());
  assert.equal(f.outputs.list().length, 3);
});

/** @case Delivery is routed by the stored target after Conversation deletion, including process restart and ambiguous sends. */
test("Lark sends to explicit Output target after Conversation deletion and reuses retry identity after restart", async (t) => {
  const f = await setup(t);
  const spec: OutputSpec = { ...f.spec("发给明确的群"), target: larkAddress("app", "unseen-chat") };
  f.outputs.create(f.session.id, "delivery", spec);
  await f.client.delete(f.conversation, f.conversation.metadata.name);
  const sent: { chatId: string; id: string }[] = [];
  let fail = true;
  const transport: LarkTransport = { async start() {}, close() {}, async send(chatId, _text, id) {
    sent.push({ chatId, id }); if (fail) { fail = false; throw new Error("ambiguous send"); }
  } };
  const service = { receive: async () => { throw new Error("must not execute Input"); }, outputs: () => f.outputs.list().map(outputView),
    outputSending: async (id: string) => f.outputs.begin(id), outputDelivered: async (id: string) => f.outputs.delivered(id),
    outputRetry: async (id: string, error: string, at: string) => f.outputs.retry(id, error, at) };
  let channel = new LarkChannel(f.root, "app", service, transport, pino({ level: "silent" }));
  t.after(() => channel.close());
  await channel.deliver();
  assert.equal(f.outputs.get("delivery")!.status.phase, "pending");
  await channel.close();
  f.outputs.retry("delivery", "test retry due", new Date(0).toISOString());
  channel = new LarkChannel(f.root, "app", service, transport, pino({ level: "silent" }));
  await channel.deliver();
  assert.deepEqual(sent, [{ chatId: "unseen-chat", id: sent[0]!.id }, { chatId: "unseen-chat", id: sent[0]!.id }]);
  assert.equal(f.outputs.get("delivery")!.status.phase, "delivered");
  assert.equal(f.outputs.get("delivery")!.status.attempts, 2);
  await channel.deliver(); assert.equal(sent.length, 2);
});
