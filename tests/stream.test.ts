import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { StreamStore } from "../src/host/stream/store.ts";
import { STREAM_TYPE } from "@compforge/aide-plugin";
import { OUTPUT_TYPE } from "../plugins/personal/output/model.ts";
import { outputSpec } from "../plugins/personal/output.ts";
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
  const output = store.create("test", "live", { ...outputSpec(topic, { topicId: "test", text: "" }), streaming: true });
  return { home, topics, store, output, streams: store.streams, ref: output.spec.stream };
}
const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert(Date.now() < deadline, "Timed out waiting for stream delivery"); await new Promise(resolve => setTimeout(resolve, 10)); }
};

test("Stream appends and closes atomically, resumes by seq, and rejects a replaced identity", async t => {
  const f = await setup(t);
  assert.equal(f.streams.get(f.ref).metadata.owner!.uid, f.output.metadata.uid);
  f.streams.append(f.ref, [{ kind: "think", delta: "检查中" }, { kind: "text", delta: "答" }]);
  const reopened = new StreamStore(f.home, "personal");
  assert.deepEqual(reopened.read(f.ref, 1), [{ seq: 2, kind: "text", delta: "答" }]);
  reopened.append(f.ref, [{ kind: "text", delta: "案" }]);
  reopened.complete(f.ref);
  assert.equal(f.streams.snapshot(f.ref).text, "答案");
  assert.equal(f.streams.snapshot(f.ref).think, "检查中");
  assert.equal(f.streams.get(f.ref).status.lastSeq, 3);
  assert.throws(() => f.streams.append(f.ref, [{ kind: "text", delta: "晚到" }]), /closed/);
  assert.throws(() => f.streams.get({ ...f.ref, uid: "replaced" }), /unavailable/);
});

test("Content capacity rollback leaves neither a chunk nor a tail advancement", async t => {
  const f = await setup(t);
  f.store.storage.configure({ defaults: { maxResourceBytes: 3000, maxCount: 10000, maxBytes: 128 * 1024 * 1024, order: "released" } });
  assert.throws(() => f.streams.append(f.ref, [{ kind: "text", delta: "x".repeat(4000) }]), ResourceCapacityError);
  assert.equal(f.streams.get(f.ref).status.lastSeq, 0);
  assert.deepEqual(f.streams.read(f.ref), []);
});

test("Deleting Output marks all owned streams, rejects writers, and deletes chunk storage", async t => {
  const f = await setup(t);
  f.streams.append(f.ref, [{ kind: "text", delta: "raw" }]);
  const replacement = f.store.replacement(f.output, "notice", "muted");
  const changes = f.store.resources.requestDeletion(OUTPUT_TYPE, "live");
  assert.deepEqual(new Set(changes.map(c => c.resource.kind)), new Set(["Output", "Stream"]));
  assert.throws(() => f.streams.append(f.ref, [{ kind: "text", delta: "late" }]), /unavailable/);
  for (const ref of [f.ref, replacement]) f.store.resources.finalizeDeletion(STREAM_TYPE, ref.name);
  f.store.resources.finalizeDeletion(OUTPUT_TYPE, "live");
  assert.equal(f.store.storage.db.prepare("SELECT count(*) AS n FROM stream_chunks").get()!.n, 0);
  assert.equal(f.store.storage.db.prepare("SELECT count(*) AS n FROM resource_payload_sizes").get()!.n, 0);
});

test("Output sends early chunks but delivered waits for closed stream and acknowledged final update", async t => {
  const f = await setup(t);
  f.store.check = async id => approveFixtureOutput(f.store, id);
  const sent: OutputMessage[] = [];
  let release: (() => void) | undefined;
  const delivery = new OutputDelivery(f.store, () => ({ replay: "idempotent", streaming: true, async send(message) {
    sent.push(message);
    if (message.stream?.phase === "completed") await new Promise<void>(resolve => { release = resolve; });
    return { id: "card", scope: "test" };
  } }), pino({ level: "silent" }));
  t.after(() => delivery.close());
  await delivery.reconcile("live");
  f.streams.append(f.ref, [{ kind: "think", delta: "checking" }]);
  await until(() => sent.length === 1);
  assert.equal(f.store.get("live")!.status.phase, "sending");
  f.streams.append(f.ref, [{ kind: "text", delta: "answer" }]);
  f.streams.complete(f.ref);
  await until(() => !!release);
  assert.notEqual(f.store.get("live")!.status.phase, "delivered");
  release!();
  await until(() => f.store.get("live")!.status.phase === "delivered");
  assert.equal(f.store.get("live")!.status.delivery!.confirmedSeq, 2);
  assert.equal(sent.at(-1)!.text, "answer");
  assert.equal(sent.at(-1)!.stream!.think, "checking");
});


test("A full Stream can still close, and Stream quota reclaims the released Output ownership tree", async t => {
  const f = await setup(t);
  f.store.storage.configure({ defaults: { maxResourceBytes: 3500, maxCount: 10000, maxBytes: 128 * 1024 * 1024, order: "released" } });
  for (;;) {
    try { f.streams.append(f.ref, [{ kind: "text", delta: "x".repeat(100) }]); }
    catch (error) { assert(error instanceof ResourceCapacityError); break; }
  }
  f.streams.interrupt(f.ref, "full");
  assert.equal(f.streams.get(f.ref).status.phase, "interrupted");
  approveFixtureOutput(f.store, "live"); f.store.begin("live"); f.store.delivered("live");
  f.store.storage.configure({ kinds: { "aide.dev/Stream": { maxCount: 1 } } });
  const next = f.store.create("test", "next", { ...outputSpec(f.topics.resource("test")!, { topicId: "test", text: "next" }) });
  assert.equal(f.store.get("live"), undefined);
  assert.throws(() => f.streams.get(f.ref), /unavailable/);
  assert.equal(f.streams.snapshot(next.spec.stream).text, "next");
  assert.equal(f.store.storage.db.prepare("SELECT count(*) AS n FROM stream_chunks WHERE uid=?").get(f.ref.uid)!.n, 0);
});
