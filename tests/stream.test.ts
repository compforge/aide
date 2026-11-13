import { collectResources } from "./fixtures/resource-gc.ts";
import { DeliveryError } from "@compforge/aide-connector";
import { outputPolicy } from "../plugins/personal/output/config.ts";
import { readAgentStream } from "../src/stream/agent.ts";
import { composeMail, replacementMail } from "../plugins/personal/stream/writer.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { StreamStore } from "../src/host/stream/store.ts";
import { STREAM_TYPE } from "@compforge/aide-plugin";
import { OUTPUT_TYPE } from "../plugins/personal/output/model.ts";
import { mailDraft } from "../plugins/personal/output.ts";
import { TopicStore } from "./topic-fixture.ts";
import { approveFixtureOutput } from "./output-fixture.ts";
import { OutputDelivery, type OutputMessage } from "../plugins/personal/output/delivery.ts";
import { ResourceCapacityError } from "../src/host/resource/storage.ts";

async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-stream-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const topics = new TopicStore({ dir: home });
  const topic = await topics.ensure("test");
  const store = topics.outputStore;
  const output = composeMail(store, "test", "live", { ...mailDraft(topic, { topicId: "test", text: "" }), content: { kind: "agent" } });
  return { home, topics, store, output, streams: store.streams, ref: output.spec.stream };
}
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert(Date.now() < deadline, "Timed out waiting for stream delivery"); await new Promise(resolve => setTimeout(resolve, 10)); }
};

test("Stream appends and closes atomically, resumes by seq, and rejects a replaced identity", async t => {
  const f = await setup(t);
  assert.equal(f.streams.get(f.ref).metadata.owner!.uid, f.output.metadata.uid);
  f.streams.append(f.ref, [{ kind: "agent_thought_chunk", payload: { messageId: "reply", content: { type: "text", text: "检查中" } } }, { kind: "agent_message_chunk", payload: { messageId: "reply", content: { type: "text", text: "答" } } }]);
  const reopened = new StreamStore(f.home, "personal");
  assert.deepEqual(reopened.read(f.ref, 1), [{ seq: 2, kind: "agent_message_chunk", payload: { messageId: "reply", content: { type: "text", text: "答" } } }]);
  reopened.append(f.ref, [{ kind: "agent_message_chunk", payload: { messageId: "reply", content: { type: "text", text: "案" } } }]);
  reopened.complete(f.ref);
  assert.equal(readAgentStream(f.streams.reader(f.ref)).text, "答案");
  assert.equal(readAgentStream(f.streams.reader(f.ref)).think, "检查中");
  assert.equal(f.streams.get(f.ref).status.lastSeq, 3);
  assert.throws(() => f.streams.append(f.ref, [{ kind: "agent_message_chunk", payload: { messageId: "reply", content: { type: "text", text: "晚到" } } }]), /closed/);
  assert.throws(() => f.streams.get({ ...f.ref, uid: "replaced" }), /unavailable/);
});

test("Content capacity rollback leaves neither a chunk nor a tail advancement", async t => {
  const f = await setup(t);
  f.store.storage.configure({ defaults: { maxResourceBytes: 3000, maxCount: 10000, maxBytes: 128 * 1024 * 1024, order: "released" } });
  assert.throws(() => f.streams.append(f.ref, [{ kind: "agent_message_chunk", payload: { messageId: "reply", content: { type: "text", text: "x".repeat(4000) } } }]), ResourceCapacityError);
  assert.equal(f.streams.get(f.ref).status.lastSeq, 0);
  assert.deepEqual(f.streams.read(f.ref), []);
});

test("Deleting Output marks all owned streams, rejects writers, and deletes chunk storage", async t => {
  const f = await setup(t);
  f.streams.append(f.ref, [{ kind: "agent_message_chunk", payload: { messageId: "reply", content: { type: "text", text: "raw" } } }]);
  const replacement = replacementMail(f.store, f.output, "notice", "muted");
  const changes = f.store.resources.requestDeletion(OUTPUT_TYPE, "live");
  assert.deepEqual(new Set(changes.map(c => c.resource.kind)), new Set(["Output", "Stream"]));
  assert.throws(() => f.streams.append(f.ref, [{ kind: "agent_message_chunk", payload: { messageId: "reply", content: { type: "text", text: "late" } } }]), /unavailable/);
  for (const ref of [f.ref, replacement]) f.store.resources.finalizeDeletion(STREAM_TYPE, ref.name);
  f.store.resources.finalizeDeletion(OUTPUT_TYPE, "live");
  assert.equal(f.store.storage.db.prepare("SELECT count(*) AS n FROM stream_records").get()!.n, 0);
  assert.equal(f.store.storage.db.prepare("SELECT count(*) AS n FROM resource_payload_sizes").get()!.n, 0);
});

test("Output sends early chunks but delivered waits for closed stream and acknowledged final update", async t => {
  const f = await setup(t);
  f.store.check = async id => approveFixtureOutput(f.store, id);
  const sent: OutputMessage[] = [];
  let release: (() => void) | undefined;
  const delivery = new OutputDelivery(f.store, () => ({ replay: "idempotent", streaming: true, async send(message) {
    sent.push(message);
    if (message.stream.status.phase === "completed") await new Promise<void>(resolve => { release = resolve; });
    return { id: "card", scope: "test" };
  } }), pino({ level: "silent" }), outputPolicy({ maxAttempts: 2 }));
  t.after(() => delivery.close());
  await delivery.reconcile("live");
  f.streams.append(f.ref, [{ kind: "agent_thought_chunk", payload: { messageId: "reply", content: { type: "text", text: "checking" } } }]);
  await until(() => sent.length === 1);
  assert.equal(f.store.get("live")!.status.phase, "sending");
  f.streams.append(f.ref, [{ kind: "agent_message_chunk", payload: { messageId: "reply", content: { type: "text", text: "answer" } } }]);
  f.streams.complete(f.ref);
  await until(() => !!release);
  assert.notEqual(f.store.get("live")!.status.phase, "delivered");
  release!();
  await until(() => f.store.get("live")!.status.phase === "delivered");
  assert.equal(f.store.get("live")!.status.delivery!.confirmedSeq, 2);
  assert.equal(f.store.get("live")!.status.attempts, 2);
  assert.equal(readAgentStream(sent.at(-1)!.stream).text, "answer");
  assert.equal(readAgentStream(sent.at(-1)!.stream).think, "checking");
});


test("A full Stream can still close, and Stream quota reclaims the released Output ownership tree", async t => {
  const f = await setup(t);
  f.store.storage.configure({ defaults: { maxResourceBytes: 3500, maxCount: 10000, maxBytes: 128 * 1024 * 1024, order: "released" } });
  let full = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { f.streams.append(f.ref, [{ kind: "agent_message_chunk", payload: { messageId: "reply", content: { type: "text", text: "x".repeat(100) } } }]); }
    catch (error) { assert(error instanceof ResourceCapacityError); full = true; break; }
  }
  assert(full, "bounded attempts must reach the configured quota");
  assert(f.streams.get(f.ref).status.lastSeq > 0);
  f.streams.interrupt(f.ref, "full");
  assert.equal(f.streams.get(f.ref).status.phase, "interrupted");
  approveFixtureOutput(f.store, "live"); f.store.begin("live"); f.store.delivered("live");
  f.store.storage.configure({ kinds: { "aide.dev/Stream": { maxCount: 1 } } });
  await collectResources(f.store.storage);
  const next = composeMail(f.store, "test", "next", { ...mailDraft(f.topics.resource("test")!, { topicId: "test", text: "next" }) });
  assert.equal(f.store.get("live"), undefined);
  assert.throws(() => f.streams.get(f.ref), /unavailable/);
  assert.equal(readAgentStream(f.streams.reader(next.spec.stream)).text, "next");
  assert.equal(f.store.storage.db.prepare("SELECT count(*) AS n FROM stream_records WHERE uid=?").get(f.ref.uid)!.n, 0);
});


test("Agent mail replays upserts, clears and tool patches without rewriting its history", async t => {
  const f = await setup(t), append = (events: import("../src/stream/agent.ts").AgentStreamEvent[]) => f.streams.append(f.ref, events);
  append([
    { kind: "agent_message_chunk", payload: { messageId: "reply", content: { type: "text", text: "draft" } } },
    { kind: "agent_message", payload: { messageId: "reply", content: [{ type: "text", text: "revised" }] } },
    { kind: "agent_message", payload: { messageId: "reply", phase: "final" } },
    { kind: "agent_thought", payload: { messageId: "thought", content: [{ type: "text", text: "checking" }] } },
    { kind: "tool_call_update", payload: { toolCallId: "read", title: "Read evidence", status: "in_progress", rawInput: { path: "note" } } },
    { kind: "tool_call_content_chunk", payload: { toolCallId: "read", content: { type: "text", text: "evidence" } } },
  ]);
  const pinned = f.streams.reader(f.ref), before = readAgentStream(pinned, f.streams);
  assert.equal(before.text, "revised");
  assert.equal(before.tools[0]!.status, "in_progress");
  append([
    { kind: "agent_message", payload: { messageId: "reply", content: null } },
    { kind: "agent_thought", payload: { messageId: "thought", content: [] } },
    { kind: "tool_call_update", payload: { toolCallId: "read", status: "completed" } },
  ]);
  assert.equal(readAgentStream(pinned).text, "revised", "reader cannot cross its captured tail");
  const after = readAgentStream(f.streams.reader(f.ref), f.streams);
  assert.equal(after.text, ""); assert.equal(after.think, "");
  assert.equal(after.tools[0]!.status, "completed");
  assert.deepEqual(after.tools[0]!.content, [{ type: "text", text: "evidence" }]);
  assert.deepEqual(after.tools[0]!.rawInput, { path: "note" });
  assert.equal(before.tools[0]!.status, "in_progress", "later patches cannot mutate returned views");
  append([{ kind: "tool_call_update", payload: { toolCallId: "read", content: null, rawInput: null } }]);
  assert.deepEqual(readAgentStream(f.streams.reader(f.ref), f.streams).tools[0]!.content, []);
  f.streams.complete(f.ref);
  let reads = 0;
  const reader = f.streams.reader(f.ref), cached = { ...reader, read: (...args: Parameters<typeof reader.read>) => { reads++; return reader.read(...args); } };
  readAgentStream(cached, f.streams); readAgentStream(cached, f.streams);
  assert.equal(reads, 0, "unchanged previews reuse the projection cursor");
  assert.equal(f.streams.read(f.ref).length, 10, "upserts append records instead of editing earlier content");
});

test("Output courier acknowledges opaque mail without decoding its body", async t => {
  const f = await setup(t);
  f.streams.append(f.ref, [{ kind: "opaque", payload: { value: "courier does not read this" } }]);
  f.streams.complete(f.ref);
  f.store.check = async id => approveFixtureOutput(f.store, id);
  let received = false;
  const delivery = new OutputDelivery(f.store, () => ({ replay: "idempotent", async send(message) {
    assert.equal("text" in message, false);
    assert.equal(message.stream.ref.uid, f.ref.uid);
    assert.deepEqual(message.stream.read().map(r => r.kind), ["opaque"]);
    received = true;
    return { id: "opaque-receipt", scope: "test" };
  } }), pino({ level: "silent" }), outputPolicy({ maxAttempts: 1 }));
  t.after(() => delivery.close());
  await delivery.reconcile("live");
  assert(received); assert.equal(f.store.get("live")!.status.phase, "delivered");
});

/** @case Exhausting successful streaming sends stops only the courier; the producer can finish and retain the full answer. */
test("Output attempt exhaustion never closes its generating Stream", async t => {
  const f = await setup(t);
  f.store.check = async id => approveFixtureOutput(f.store, id);
  let sends = 0;
  const delivery = new OutputDelivery(f.store, () => ({ replay: "idempotent", streaming: true, async send() {
    sends++; throw new DeliveryError({ kind: "retryable", code: "http:429", message: "Rejected", retryAfterMs: 0 });
  } }), pino({ level: "silent" }), outputPolicy({ maxAttempts: 2 }));
  t.after(() => delivery.close());
  const append = (text: string) => f.streams.append(f.ref, [{ kind: "agent_message_chunk", payload: { messageId: "reply", content: { type: "text", text } } }]);
  await delivery.reconcile("live");
  append("part one ");
  await until(() => sends === 1);
  append("part two ");
  await delivery.reconcile("live");
  await until(() => f.store.get("live")!.status.phase === "failed");
  assert.equal(f.streams.get(f.ref).status.phase, "open");
  const status = f.store.get("live")!.status;
  assert.equal(status.attempts, 2); assert.equal(status.delivery!.confirmedSeq, undefined);
  assert.equal(status.receipt, undefined);
  assert.match(status.lastError!, /attempt limit reached/);
  // Simulate subsequent Chief events and normal completion after delivery has already stopped.
  append("final answer"); f.streams.complete(f.ref);
  await delivery.reconcile("live");
  assert.equal(sends, 2); assert.equal(f.store.get("live")!.status.phase, "failed");
  assert.equal(f.streams.get(f.ref).status.phase, "completed");
  assert.equal(readAgentStream(f.streams.reader(f.ref)).text, "part one part two final answer");
});


test("A permanently rejected delivery leaves the producer free to finish its Stream", async t => {
  const f = await setup(t); let sends = 0;
  f.store.check = async id => approveFixtureOutput(f.store, id);
  const delivery = new OutputDelivery(f.store, () => ({ replay: "idempotent", streaming: true, async send() {
    sends++; throw new DeliveryError({ kind: "permanent", code: "permission_denied", biz_code: "230013", message: "Denied" });
  } }), pino({ level: "silent" }));
  t.after(() => delivery.close());
  f.streams.append(f.ref, [{ kind: "agent_message_chunk", payload: { messageId: "reply", content: { type: "text", text: "draft " } } }]);
  await delivery.reconcile("live");
  assert.equal(f.store.get("live")!.status.phase, "failed");
  assert.equal(f.streams.get(f.ref).status.phase, "open");
  f.streams.append(f.ref, [{ kind: "agent_message_chunk", payload: { messageId: "reply", content: { type: "text", text: "complete answer" } } }]);
  f.streams.complete(f.ref);
  await delivery.reconcile("live");
  assert.equal(sends, 1); assert.equal(readAgentStream(f.streams.reader(f.ref)).text, "draft complete answer");
  assert.equal(f.store.get("live")!.status.phase, "failed");
});


// @case More successful progress operations than maxAttempts still deliver the terminal snapshot, including a close with no new sequence.
test("Successful streaming operations each get a fresh attempt budget and deliver the final close", { timeout: 15000 }, async t => {
  const f = await setup(t); f.store.check = async id => approveFixtureOutput(f.store, id);
  const seen: { seq: number; phase: string; text: string }[] = [];
  const worker = new OutputDelivery(f.store, () => ({ replay: "idempotent", streaming: true, async send({ stream }) {
    seen.push({ seq: stream.status.lastSeq, phase: stream.status.phase, text: readAgentStream(stream).text });
    if (seen.length < 7) f.streams.append(f.ref, [{ kind: "agent_message", payload: { messageId: "reply", content: [{ type: "text", text: `progress ${seen.length}` }] } }]);
    else if (seen.length === 7) f.streams.complete(f.ref);
    return { id: "one-card", scope: "fixture" };
  } }), pino({ level: "silent" }), outputPolicy({ maxAttempts: 1 }));
  t.after(() => worker.close());
  f.streams.append(f.ref, [{ kind: "agent_message", payload: { messageId: "reply", content: [{ type: "text", text: "start" }] } }]);
  await worker.reconcile("live");
  const deadline = Date.now() + 12000;
  while (f.store.get("live")!.status.phase !== "delivered") { assert(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)); }
  assert.equal(seen.length, 8);
  assert.equal(seen.at(-1)!.seq, seen.at(-2)!.seq);
  assert.equal(seen.at(-1)!.phase, "completed");
  assert.equal(f.store.get("live")!.status.attempts, 8);
  assert.equal(f.store.get("live")!.status.delivery!.operation, undefined);
});

// @case A retry reopens the saved snapshot after append, close and worker reconstruction; later events cannot reset its budget.
test("Stream operation snapshots and retry counts survive growth, closure and reconstruction", async t => {
  const f = await setup(t); f.store.check = async id => approveFixtureOutput(f.store, id);
  f.streams.append(f.ref, [{ kind: "agent_message", payload: { messageId: "reply", content: [{ type: "text", text: "original" }] } }]);
  let sends = 0;
  const transport = () => ({ replay: "idempotent" as const, streaming: true, async send({ stream }: OutputMessage) {
    sends++;
    assert.equal(stream.status.phase, "open"); assert.equal(stream.status.lastSeq, 1);
    assert.equal(readAgentStream(stream).text, "original");
    throw new DeliveryError({ kind: "retryable", message: "Rejected", retryAfterMs: 0 });
  } });
  const first = new OutputDelivery(f.store, transport, pino({ level: "silent" }), outputPolicy({ maxAttempts: 2 }));
  await first.reconcile("live"); await first.close();
  f.streams.append(f.ref, [{ kind: "agent_message", payload: { messageId: "reply", content: [{ type: "text", text: "final" }] } }]);
  f.streams.complete(f.ref);
  const store = new (await import("../plugins/personal/output/store.ts")).OutputStore(f.home);
  store.check = async id => approveFixtureOutput(store, id);
  const second = new OutputDelivery(store, transport, pino({ level: "silent" }), outputPolicy({ maxAttempts: 2 }));
  t.after(() => second.close());
  await second.reconcile("live");
  assert.equal(sends, 2); assert.equal(store.get("live")!.status.phase, "failed");
  assert.equal(store.get("live")!.status.delivery!.operation!.attempts, 2);
  assert.equal(f.streams.get(f.ref).status.phase, "completed");
});


test("A successful retry confirms its pinned progress before starting the latest terminal operation", async t => {
  const f = await setup(t); f.store.check = async id => approveFixtureOutput(f.store, id);
  f.streams.append(f.ref, [{ kind: "agent_message", payload: { messageId: "reply", content: [{ type: "text", text: "draft" }] } }]);
  const seen: string[] = [];
  const worker = new OutputDelivery(f.store, () => ({ replay: "idempotent", streaming: true, async send({ stream }) {
    seen.push(`${stream.status.phase}:${readAgentStream(stream).text}`);
    if (seen.length === 1) throw new DeliveryError({ kind: "retryable", message: "Rejected", retryAfterMs: 0 });
    return { id: "one-card", scope: "fixture" };
  } }), pino({ level: "silent" }), outputPolicy({ maxAttempts: 2 }));
  t.after(() => worker.close());
  await worker.reconcile("live");
  f.streams.append(f.ref, [{ kind: "agent_message", payload: { messageId: "reply", content: [{ type: "text", text: "answer" }] } }]);
  f.streams.complete(f.ref);
  await worker.reconcile("live");
  await until(() => f.store.get("live")!.status.phase === "delivered");
  assert.deepEqual(seen, ["open:draft", "open:draft", "completed:answer"]);
  assert.equal(f.store.get("live")!.status.attempts, 3);
  assert.equal(f.store.get("live")!.status.delivery!.confirmedSeq, 2);
});
