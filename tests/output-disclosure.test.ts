import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { TopicStore } from "./topic-fixture.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { PersonDefinition } from "../plugins/personal/person/definition.ts";
import { PERSON_TYPE, LOCAL_ME, personRef, type PersonResource, type PersonRef } from "../plugins/personal/person/model.ts";
import { NOTE_TYPE, noteVersion, type NoteResource } from "../plugins/personal/note/model.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { OutputDisclosure, type DisclosurePorts, type OutputAudience } from "../plugins/personal/output/disclosure.ts";
import { outputSpec } from "../plugins/personal/output.ts";
import { webAddress, larkPersonAddress, isChannelAddress } from "../src/channel/address.ts";
import { outputView } from "../src/output.ts";
import { channelOutputs } from "../src/channel/output.ts";
import type { Sensitivity, Visibility } from "../plugins/personal/disclosure.ts";

async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-disclosure-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const topics = new TopicStore({ dir: home, home, id: "owner" }), store = topics.outputStore;
  topics.resources.storage.register("personal", [PersonDefinition]);
  const client = createResourceClient(topics.resources);
  const topic = await topics.ensure("topic");
  const status = { updatedAt: new Date().toISOString(), updatedBy: "user" as const };
  const me = await client.create(PERSON_TYPE, { name: "me", spec: { name: "Me", identities: [LOCAL_ME] }, status }) as PersonResource;
  let other = await client.create(PERSON_TYPE, { name: "c", spec: { name: "C", identities: [], clearance: "L1" }, status }) as PersonResource;
  let audience: OutputAudience = { people: [other], complete: true, private: true };
  let checks = 0;
  const ports: DisclosurePorts = { marks: { identities: [LOCAL_ME] },
    audience: async target => isChannelAddress(target) && target.channelId === "web" ? { people: [me], complete: true, private: true } : audience,
    contactMe: async () => ({ target: webAddress("topic"), receivers: [personRef(me)] }),
    check: async () => { checks++; return { allowed: true, reason: "supported" }; } };
  const checker = new OutputDisclosure(store, ports, pino({ level: "silent" }));
  store.check = id => checker.reconcile(id);
  async function note(sensitivity: Sensitivity = "L1", visibility: Visibility = "any", people: PersonRef[] = []) {
    return await client.create(NOTE_TYPE, { name: `n-${store.resources.list(NOTE_TYPE).length}`, spec: { subject: resourceRef(topic), text: "A verified fact", sensitivity, visibility, people }, status: { updatedAt: new Date().toISOString() } }) as NoteResource;
  }
  function output(id: string, n?: NoteResource, target = larkPersonAddress("app", "ou_c")) {
    return store.create("topic", id, { ...outputSpec(topic, { topicId: "topic", text: "A verified fact", target }),
      ...(n ? { notes: [{ uid: n.metadata.uid, version: noteVersion(n) }] } : {}) });
  }
  return { store, client, topic, me, other, note, output, checker, ports, checks: () => checks,
    audience: (next: OutputAudience) => { audience = next; },
    clearance: async (clearance: Sensitivity) => { other = await client.replace(other, { ...other.spec, clearance }, other.status); audience = { ...audience, people: [other] }; } };
}

test("unchecked Output is pending and cannot reach a Channel, even Web", async t => {
  const f = await setup(t); const output = f.output("x", undefined, webAddress("topic"));
  assert.equal(output.status.phase, "pending");
  assert.deepEqual(channelOutputs({ outputs: () => [outputView(output)] }), []);
  assert.throws(() => f.store.begin("x"), /not been checked/);
  await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.phase, "delivered");
  assert.equal(f.checks(), 0, "Me can receive all private material without a model check");
});

test("permitted output retains intended content and checked delivery survives retries", async t => {
  const f = await setup(t); const original = f.output("x", await f.note());
  await Promise.all([f.checker.reconcile("x"), f.checker.reconcile("x")]);
  assert.equal(f.checks(), 1);
  assert.deepEqual(f.store.get("x")!.spec, original.spec);
  assert.equal(f.store.get("x")!.status.disclosure!.decision, "allowed");
  f.store.begin("x"); f.store.retry("x", "transport refused", new Date().toISOString());
  await f.store.prepare("x");
  assert.equal(f.checks(), 1);
  assert.equal(f.store.get("x")!.status.delivery!.text, original.spec.text);
  f.store.begin("x"); f.store.delivered("x");
  await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.phase, "delivered");
});

test("denied output redirects to Me on the same resource, preserving original intent", async t => {
  const f = await setup(t); const original = f.output("x", await f.note("L3"));
  await f.checker.reconcile("x");
  const result = f.store.get("x")!;
  assert.deepEqual(result.spec, original.spec);
  assert.equal(result.status.disclosure!.decision, "denied");
  assert.deepEqual(result.status.delivery!.target, webAddress("topic"));
  assert.match(result.status.delivery!.text, /clearance L1/);
  assert.match(result.status.delivery!.text, /A verified fact/);
  assert.equal(result.status.phase, "delivered");
  await f.checker.reconcile("x");
  assert.equal(f.store.list().length, 1);
});

test("sufficient clearance does not grant people visibility; claimed receivers do not override actual audience", async t => {
  const f = await setup(t); await f.clearance("L3");
  const n = await f.note("L1", "people", [personRef(f.me) as PersonRef]);
  const draft = f.store.create("topic", "x", { ...outputSpec(f.topic, { topicId: "topic", text: n.spec.text, target: larkPersonAddress("app", "ou_c"), receivers: [personRef(f.me)] }), notes: [{ uid: n.metadata.uid, version: noteVersion(n) }] });
  f.audience({ people: [f.me, f.other], complete: true, private: false });
  await f.checker.reconcile("x");
  assert.equal(f.store.get(draft.metadata.name)!.status.disclosure!.decision, "denied");
  assert.match(f.store.get("x")!.status.disclosure!.reason, /outside visibility/);
});

test("every cited material restricts the audience, including the latest Input", async t => {
  const f = await setup(t);
  const note = await f.note("L1", "any");
  const { INPUT_TYPE } = await import("../plugins/personal/input/model.ts");
  const input = await f.client.create(INPUT_TYPE, { name: "private-input", spec: { origin: "channel", originId: "web", text: "Private detail", sensitivity: "L3", visibility: "people", sender: personRef(f.me) }, status: {} });
  f.store.create("topic", "x", { ...outputSpec(f.topic, { topicId: "topic", text: "A verified fact and private detail", target: larkPersonAddress("app", "ou_c") }), notes: [{ uid: note.metadata.uid, version: noteVersion(note) }], inputIds: [input.metadata.name], inputUids: { [input.metadata.name]: input.metadata.uid } });
  await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.disclosure!.decision, "denied");
  assert.match(f.store.get("x")!.status.disclosure!.reason, /Input|private-input/);
  assert.equal(f.checks(), 0, "Deterministic denial does not spend a model call");
});

test("missing or stale materials fail closed and unavailable checker notifies Me", async t => {
  const f = await setup(t); const n = await f.note();
  f.output("stale", n); await f.client.replace(n, { ...n.spec, text: "Changed" }, n.status);
  await f.checker.reconcile("stale");
  assert.match(f.store.get("stale")!.status.disclosure!.reason, /changed/);
  f.output("missing"); await f.checker.reconcile("missing");
  assert.match(f.store.get("missing")!.status.disclosure!.reason, /No verifiable/);
  f.ports.check = async () => { throw new Error("model unavailable"); };
  f.output("failed", await f.note()); await f.checker.reconcile("failed");
  assert.equal(f.store.get("failed")!.status.disclosure!.decision, "denied");
});

test("permission change during async review never publishes a stale authorization", async t => {
  const f = await setup(t); await f.clearance("L3"); f.output("x", await f.note("L3"));
  f.ports.check = async () => { await f.clearance("L1"); return { allowed: true, reason: "supported" }; };
  await assert.rejects(f.checker.reconcile("x"), /changed during review/);
  assert.equal(f.store.get("x")!.status.delivery, undefined);
  await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.disclosure!.decision, "denied");
});

test("unknown group audience and unsafe fallback never authorize the original target", async t => {
  const f = await setup(t); f.audience({ people: [f.other], complete: false, private: false });
  f.output("x", await f.note());
  f.ports.contactMe = async () => ({ target: larkPersonAddress("app", "ou_c"), receivers: [personRef(f.me)] });
  await assert.rejects(f.checker.reconcile("x"), /not a verified private/);
  assert.equal(f.store.get("x")!.status.delivery, undefined);
  assert.equal(f.store.get("x")!.status.phase, "pending");
});

test("revoked permission after attempted delivery stops further effects as uncertain", async t => {
  const f = await setup(t); await f.clearance("L3"); f.output("x", await f.note("L3"));
  await f.checker.reconcile("x"); f.store.begin("x"); f.store.retry("x", "unknown network failure", new Date().toISOString());
  const target = f.store.get("x")!.status.delivery!.target;
  await f.clearance("L1"); await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.phase, "uncertain");
  assert.deepEqual(f.store.get("x")!.status.delivery!.target, target);
});

test("topic visibility uses pinned authorization scope rather than recent associated people", async t => {
  const f = await setup(t); const n = await f.note("L1", "topic");
  const topic = await f.client.replace(f.topic, { ...f.topic.spec, people: [personRef(f.other) as PersonRef] }, f.topic.status);
  const scoped = await f.client.replace(n, { ...n.spec, disclosureScope: { ...resourceRef(topic), kind: "Topic", namespace: "v1", uid: topic.metadata.uid } }, n.status);
  f.output("x", scoped); await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.disclosure!.decision, "allowed");
  await f.client.replace(topic, { ...topic.spec, people: [] }, topic.status);
  await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.disclosure!.decision, "denied");
});


test("failed fallback retries only the saved Me delivery without another Output", async t => {
  const f = await setup(t); const target = larkPersonAddress("app", "ou_me");
  const audience = f.ports.audience;
  f.ports.audience = async address => JSON.stringify(address) === JSON.stringify(target)
    ? { people: [f.me], complete: true, private: true } : audience(address);
  f.ports.contactMe = async () => ({ target, receivers: [personRef(f.me)] });
  f.output("x", await f.note("L3")); await f.checker.reconcile("x");
  const actual = f.store.get("x")!.status.delivery;
  f.store.begin("x"); f.store.retry("x", "transport temporarily unavailable", new Date().toISOString());
  await f.checker.reconcile("x"); f.store.begin("x"); f.store.delivered("x");
  assert.deepEqual(f.store.get("x")!.status.delivery, actual);
  assert.equal(f.store.get("x")!.status.disclosure!.decision, "denied");
  assert.equal(f.store.list().length, 1);
});

test("revocation clears a previously approved target even when fallback is unavailable", async t => {
  const f = await setup(t); await f.clearance("L3"); f.output("x", await f.note("L3"));
  await f.checker.reconcile("x"); await f.clearance("L1");
  const contact = f.ports.contactMe;
  f.ports.contactMe = async () => { throw new Error("Default unavailable"); };
  await assert.rejects(f.checker.reconcile("x"), /Default unavailable/);
  assert.equal(f.store.get("x")!.status.delivery, undefined);
  assert.equal(f.store.get("x")!.status.disclosure!.decision, "denied");
  // Raising clearance later cannot silently revive the denied sending intent.
  await f.clearance("L3"); f.ports.contactMe = contact;
  await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.delivery!.target.kind, "channel");
  assert.deepEqual(f.store.get("x")!.status.delivery!.target, webAddress("topic"));
});

test("real Runner automatically reconciles a newly submitted Output before Web publication", async t => {
  const { Aide } = await import("../src/app.ts");
  const { fakeOptions } = await import("./fake-harness.ts");
  const home = mkdtempSync(join(tmpdir(), "aide-output-runner-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No business execution expected"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.start(); await aide.topics.ensure("automatic");
  const accepted = await aide.topics.say("automatic", undefined, "Private status for Me");
  for (let i = 0; i < 100 && aide.outputStore.get(accepted.outputId)!.status.phase !== "delivered"; i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(aide.outputStore.get(accepted.outputId)!.status.disclosure?.decision, "allowed");
  assert.equal(aide.outputStore.get(accepted.outputId)!.status.phase, "delivered");
});
