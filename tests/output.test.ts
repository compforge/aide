import { reconcileChannelOutputs } from "../src/channel/delivery.ts";
import { larkSendFailure } from "../src/channel/lark/client.ts";
import { assertChannelDelivery, larkAddress, webAddress } from "../src/channel/address.ts";
import { definition } from "./fixtures/resource-definition.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { OUTPUT_TYPE, type OutputSpec } from "../plugins/personal/output/model.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { outputPrinter } from "../plugins/personal/output/printer.ts";
import { outputView } from "../src/output.ts";
import { HarnessFixtures } from "./harness-fixture.ts";
import { personalAdmission } from "../plugins/personal/admission.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { ResourceCapacityError, ResourceStorageConfigSchema } from "../src/host/resource/storage.ts";
import { TopicStore, seedInput } from "./topic-fixture.ts";
import { outputSpec } from "../plugins/personal/output.ts";
import { LarkChannel } from "../src/channel/lark/index.ts";
import type { LarkTransport } from "../src/channel/lark/client.ts";

async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "aide-output-"));
  const session = new HarnessFixtures(root).create({ id: "owner", cwd: root });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  const topics = new TopicStore(session), outputs = topics.outputStore;
  const topic = await topics.ensure("topic");
  const provider = personalAdmission(topics.inputStore, outputs);
  const changes: string[] = [];
  const client = createResourceClient(topics.resources, (c) => changes.push(c.resource.metadata.name), undefined, provider);
  const spec = (text = "结果"): OutputSpec => outputSpec(topic, { text, topicId: "topic" });
  return { root, session, topics, topic, outputs, client, changes, spec };
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
  assert.equal(new OutputStore(f.root).list({ topicUid: f.topic.metadata.uid }).length, 3);
  assert.equal(first.status.phase, "delivered", "Web publication does not require a reader acknowledgement");
  assert.match(outputPrinter.describe(first), /第一条\n完整详情/);
  assert.equal(outputPrinter.summarize(first), "第一条 完整详情");
  assert.equal((await f.client.list(OUTPUT_TYPE)).length, 3);
  assert.equal((await f.client.get({ ...OUTPUT_TYPE, namespace: "v1", name: "one", uid: first.metadata.uid }))?.metadata.uid, first.metadata.uid);
  assert.equal((await f.client.patchStatus(first, { phase: "pending" })).status.phase, "pending");
});

/** @case Atomic publication includes resource CAS, Output admission, quota checks and observer visibility. */
test("Resource commit rolls back result and Output together on validation, conflict or capacity failure", async (t) => {
  const f = await setup(t);
  const type = { apiVersion: "test.dev/v1", kind: "Work" };
  f.topics.resources.storage.register("personal", [definition(type)]);
  let work = await f.client.create(type, { name: "work", spec: {}, status: { done: false } });
  const write = (name: string, spec: OutputSpec = f.spec()) => ({ operation: "create" as const, type: OUTPUT_TYPE, name, spec });
  let notifications = 0;
  const observed: boolean[] = [];
  f.outputs.subscribe(() => { notifications++; observed.push(f.topics.resources.get<{}, { done: boolean }>(type, "work").status.done); });
  f.changes.length = 0;
  await assert.rejects(f.client.commit([
    { operation: "patchStatus", resource: work, patch: { done: true } }, write("invalid", { ...f.spec(), text: "" }),
  ]));
  assert.equal(f.topics.resources.get<{}, { done: boolean }>(type, "work").status.done, false);
  assert.deepEqual(f.changes, []); assert.equal(notifications, 0);
  work = await f.client.patchStatus(work, { done: false });
  await f.client.patchStatus(work, { done: true });
  await assert.rejects(f.client.commit([write("conflicted"), { operation: "patchStatus", resource: work, options: { resourceVersion: work.metadata.resourceVersion }, patch: { done: false } }]), /version conflict/);
  assert.equal(f.outputs.get("conflicted"), undefined);
  assert.equal(f.outputs.storage.hasReceipt("output:conflicted"), false);
  const current = f.topics.resources.get<{}, { done: boolean }>(type, "work");
  f.outputs.storage.configure(ResourceStorageConfigSchema.parse({ kinds: { "aide.dev/Output": { maxCount: 1 } } }));
  await assert.rejects(f.client.commit([
    { operation: "patchStatus", resource: current, patch: { done: false } }, write("first"), write("second"),
  ]), ResourceCapacityError);
  assert.equal(f.outputs.list().length, 0, "A later write must not evict an earlier write from the same transaction");
  assert.equal(f.topics.resources.get<{}, { done: boolean }>(type, "work").status.done, true);
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

test("say associates optional Inputs and records Outputs for the owning execution, with tool-call idempotency", async (t) => {
  const f = await setup(t);
  for (const id of ["a", "b"]) await seedInput(f.topics, id, { origin: "channel", originId: "web", text: id, topicId: "topic" });
  let c = f.topics.resource("topic")!;
  await f.client.patchStatus(c, { execution: { id: "execution", startedAt: new Date().toISOString() } });
  const say = (text: string, key: string, inputIds?: string[]) => f.topics.say("topic", undefined, text, "execution", { idempotencyKey: key, inputIds });
  const first = await say("一起回答", "tool-1", ["a", "b"]);
  assert.deepEqual(await say("一起回答", "tool-1", ["a", "b"]), first);
  await say("补充回答", "tool-2", ["a", "b"]);
  await say("主动提醒", "tool-3");
  assert.equal(f.outputs.list().length, 3);
  await assert.rejects(say("不相关", "tool-4", ["foreign"]), /not attached/);
  c = f.topics.resource("topic")!;
  assert.equal(f.outputs.list().length, 3);
  assert.deepEqual(f.topics.get("topic")!.pendingInputIds, ["a", "b"], "Saying something does not consume Inputs");
  f.outputs.storage.configure(ResourceStorageConfigSchema.parse({ kinds: { "aide.dev/Output": { maxCount: 3 } } }));
  f.outputs.create(f.session.id, "over-capacity", f.spec());
  await f.client.patchStatus(c, { execution: null });
  f.outputs.create(f.session.id, "after-handoff", f.spec());
  assert.equal(f.outputs.list().length, 3);
});

/** @case Delivery is routed by the stored target after Topic deletion, including process restart and ambiguous sends. */
test("Lark sends to explicit Output target after Topic deletion and reuses retry identity after restart", async (t) => {
  const f = await setup(t);
  const spec: OutputSpec = { ...f.spec("发给明确的群"), target: larkAddress("app", "unseen-chat") };
  f.outputs.create(f.session.id, "delivery", spec);
  await f.client.delete(f.topic, f.topic.metadata.name);
  const sent: { chatId: string; id: string }[] = [];
  let fail = true;
  const transport: LarkTransport = { async start() {}, close() {}, async chatName() { return undefined; }, async send(chatId, _text, id) {
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


/** @case A Connector app cannot masquerade as a configured bot; rejected publication rolls back business changes too. */
test("Output admission rejects disabled or mismatched Lark targets before persistence", async t => {
  const f = await setup(t);
  const bad = { ...f.spec(), target: larkAddress("connector-app", "chat") };
  assert.throws(() => f.outputs.create("owner", "wrong-app", bad), /No configured Channel/);
  assert.throws(() => new OutputStore(f.root).create("owner", "disabled", { ...f.spec(), target: larkAddress("app", "chat") }), /disabled/);
  await assert.rejects(f.client.commit([
    { operation: "patchStatus", resource: f.topic, patch: { idleReviewCount: 99 } },
    { operation: "create", type: OUTPUT_TYPE, name: "atomic", spec: bad },
  ]), /No configured Channel/);
  assert.notEqual(f.topics.resource("topic")!.status.idleReviewCount, 99);
  assert.equal(f.outputs.list().length, 0);
  assert.equal(f.outputs.storage.hasReceipt("output:atomic"), false);
  assert.ok(f.outputs.create("owner", "valid", { ...f.spec(), target: larkAddress("app", "chat") }));
});

test("Reconfigured channels fail pending Outputs and preserve uncertain sends without replay", async t => {
  const f = await setup(t);
  for (const id of ["pending", "sending", "retrying", "delivered"]) f.outputs.create("owner", id, { ...f.spec(), target: larkAddress("app", "chat") });
  f.outputs.begin("sending"); f.outputs.delivered("delivered");
  f.outputs.begin("retrying"); f.outputs.retry("retrying", "ambiguous send", new Date(0).toISOString());
  const reopened = new OutputStore(f.root, target => assertChannelDelivery(target, ["different-app"]));
  const logs: Record<string, unknown>[] = [];
  const log = pino({}, { write(line) { logs.push(JSON.parse(line)); } });
  reconcileChannelOutputs(reopened, ["different-app"], log);
  assert.deepEqual(new Set(logs.map(record => record.outputId)), new Set(["pending", "sending", "retrying"]));
  assert.ok(logs.every(record => record.level === 50 && record.retryable === false && record.target && record.error));
  assert.equal(reopened.get("pending")!.status.phase, "failed");
  assert.equal(reopened.get("pending")!.status.attempts, 0);
  assert.equal(reopened.get("sending")!.status.phase, "uncertain");
  assert.equal(reopened.get("sending")!.status.attempts, 1);
  assert.equal(reopened.get("retrying")!.status.phase, "uncertain");
  assert.equal(reopened.get("retrying")!.status.attempts, 1);
  assert.equal(reopened.get("delivered")!.status.phase, "delivered");
  reconcileChannelOutputs(reopened, ["different-app"], log);
  assert.equal(logs.length, 3, "Terminal failures are not logged on every restart");
  assert.deepEqual(reopened.get("pending")!.spec.target, larkAddress("app", "chat"));
});

test("say acknowledges acceptance independently of delivery without recreating messages", async t => {
  const f = await setup(t);
  const target = larkAddress("app", "chat");
  const options = { target, idempotencyKey: "one" };
  const first = await f.topics.say("topic", undefined, "reply", undefined, options);
  assert.deepEqual(first, { outputId: first.outputId, accepted: true });
  assert.equal(f.outputs.get(first.outputId)!.status.phase, "pending");
  f.outputs.begin(first.outputId); f.outputs.delivered(first.outputId);
  const retry = await f.topics.say("topic", undefined, "reply", undefined, options);
  assert.deepEqual(retry, first);
  assert.equal(f.outputs.get(first.outputId)!.status.phase, "delivered");
  assert.equal(f.outputs.list().length, 1);
  const web = await f.topics.say("topic", undefined, "published", undefined, { target: webAddress("topic") });
  assert.equal(web.accepted, true);
  assert.equal(f.outputs.get(web.outputId)!.status.phase, "delivered");
});

/** @case The durable retry and operational log share safe diagnostics, without exposing SDK request data. */
test("Lark delivery failures retain diagnostic codes and delivery context without leaking credentials or text", async t => {
  const f = await setup(t);
  const target = larkAddress("app", "chat");
  f.outputs.create("owner", "send-failure", { ...f.spec("PRIVATE MESSAGE"), target });
  const logs: Record<string, unknown>[] = [];
  const log = pino({}, { write(line) { logs.push(JSON.parse(line)); } });
  const error = Object.assign(new Error("PRIVATE SDK ERROR"), { code: "ERR_BAD_REQUEST",
    config: { headers: { Authorization: "SECRET TOKEN" }, data: "PRIVATE MESSAGE" },
    response: { status: 403, data: { code: 99991672, msg: "PRIVATE RESPONSE" } } });
  const transport: LarkTransport = { async start() {}, close() {}, async chatName() { return undefined; }, async send() { throw error; } };
  const channel = new LarkChannel(f.root, "app", {
    receive: async () => { throw new Error("unused"); }, outputs: () => f.outputs.list().map(outputView),
    outputSending: async id => f.outputs.begin(id),
    outputRetry: async (id, reason, at) => f.outputs.retry(id, reason, at),
  }, transport, log);
  t.after(() => channel.close());
  await channel.deliver();
  const output = f.outputs.get("send-failure")!, record = logs.find(record => record.outputId === "send-failure")!;
  assert.equal(record.level, 40);
  assert.deepEqual(record.target, target);
  assert.equal(record.attempt, 1);
  assert.equal(record.apiCode, 99991672);
  assert.equal(record.httpStatus, 403);
  assert.equal(record.retryable, true);
  assert.equal(record.nextAttemptAt, output.status.nextAttemptAt);
  assert.equal(record.error, output.status.lastError);
  assert.equal(output.status.phase, "pending");
  assert.equal(output.status.attempts, 1);
  assert.doesNotMatch(JSON.stringify({ logs, status: output.status }), /SECRET|PRIVATE|Authorization|config/);
  const timeout = larkSendFailure(Object.assign(new Error("SECRET TOKEN"), { code: "ETIMEDOUT" }));
  assert.equal(timeout.transportCode, "ETIMEDOUT");
  assert.match(timeout.error, /ETIMEDOUT/);
  assert.doesNotMatch(JSON.stringify(timeout), /SECRET/);
  assert.deepEqual(larkSendFailure(new Error("SECRET")), { error: "Lark message.create failed; no diagnostic code available" });
});

/** @case System recovery notices keep a stable deduplication key across unrelated Chief executions. */
test("System notifications never borrow a live Chief call and remain idempotent across execution changes", async t => {
  const f = await setup(t);
  const notice = (key: string) => f.topics.say("topic", undefined, "Recovery notification", undefined,
    { target: webAddress("topic"), inputIds: [], idempotencyKey: key });
  const idle = await notice("idle-notice");
  await f.client.patchStatus(f.topics.resource("topic")!, {
    agent: { harness: "chief", sessionId: "chief-session-1" }, execution: { id: "unrelated-1", startedAt: new Date().toISOString() },
  });
  const active = await notice("active-notice");
  assert.deepEqual(await notice("idle-notice"), idle);
  assert.equal(f.outputs.get(active.outputId)!.spec.createdBy, undefined);
  assert.equal(f.outputs.get(idle.outputId)!.spec.createdBy, undefined);
  await f.client.patchStatus(f.topics.resource("topic")!, { execution: null });
  assert.deepEqual(await notice("active-notice"), active);
  await f.client.patchStatus(f.topics.resource("topic")!, {
    agent: { harness: "chief", sessionId: "chief-session-2" }, execution: { id: "unrelated-2", startedAt: new Date().toISOString() },
  });
  assert.deepEqual(await notice("active-notice"), active);
  assert.equal(f.outputs.list().length, 2);
});

/** @case Replayed agent Output retains first-admission provenance, including an absent reference. */
test("Output retries preserve original call evidence without weakening immutable content checks", async t => {
  const f = await setup(t);
  await f.client.patchStatus(f.topics.resource("topic")!, {
    agent: { harness: "chief", sessionId: "first-session" }, execution: { id: "run", startedAt: new Date().toISOString() },
  });
  const say = (key: string, text = "answer") => f.topics.say("topic", undefined, text, "run", { target: webAddress("topic"), idempotencyKey: key });
  const first = await say("tool-call");
  const recorded = f.outputs.get(first.outputId)!.spec.createdBy;
  assert.deepEqual(recorded, { agent: { harness: "chief", sessionId: "first-session" }, executionId: "run", toolCallId: "tool-call" });
  await f.client.patch(f.topics.resource("topic")!, { type: "json", value: [{ op: "replace", path: "/status/agent", value: { harness: "chief" } }] });
  const absent = await say("without-reference");
  assert.equal(f.outputs.get(absent.outputId)!.spec.createdBy, undefined);
  await f.client.patchStatus(f.topics.resource("topic")!, { agent: { harness: "chief", sessionId: "new-session" } });
  assert.deepEqual(await say("tool-call"), first);
  assert.deepEqual(f.outputs.get(first.outputId)!.spec.createdBy, recorded);
  assert.deepEqual(await say("without-reference"), absent);
  assert.equal(f.outputs.get(absent.outputId)!.spec.createdBy, undefined);
  await assert.rejects(say("tool-call", "different answer"), /different content/);
  assert.equal(f.outputs.list().length, 2);
});
