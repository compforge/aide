import { KeyedSet } from "@compforge/ts-stdx/collections";
import { personRefs } from "../plugins/personal/person/model.ts";
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
import { OutputDefinition } from "../plugins/personal/output/definition.ts";
import { OutputDelivery } from "../plugins/personal/output/delivery.ts";
import { outputSpec } from "../plugins/personal/output.ts";
import { webAddress, larkAddress, larkPersonAddress, isChannelAddress } from "../src/channel/address.ts";
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
    return await client.create(NOTE_TYPE, { name: `n-${store.resources.list(NOTE_TYPE).length}`, spec: { subject: resourceRef(topic), text: "A verified fact", sensitivity, visibility, people: personRefs(people) }, status: { updatedAt: new Date().toISOString() } }) as NoteResource;
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
  assert.equal(f.store.get("x")!.status.phase, "pending");
  assert.equal(f.checks(), 0, "Me can receive all private material without a model check");
});

test("permitted output retains intended content and checked delivery survives retries", async t => {
  const f = await setup(t); const original = f.output("x", await f.note());
  await Promise.all([f.checker.reconcile("x"), f.checker.reconcile("x")]);
  assert.equal(f.checks(), 1);
  assert.deepEqual(f.store.get("x")!.spec, original.spec);
  assert.equal(f.store.get("x")!.status.disclosure!.decision, "allowed");
  f.store.begin("x"); f.store.retry("x", "transport refused");
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
  assert.equal(result.status.phase, "pending");
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

test("Input provenance does not add a second classification system", async t => {
  const f = await setup(t); const note = await f.note();
  f.store.create("topic", "x", { ...outputSpec(f.topic, { topicId: "topic", text: note.spec.text, target: larkPersonAddress("app", "ou_c") }),
    notes: [{ uid: note.metadata.uid, version: noteVersion(note) }], inputIds: ["reclaimed-input"] });
  await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.disclosure!.decision, "allowed");
  assert.equal(f.checks(), 1);
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
  await f.checker.reconcile("x"); f.store.begin("x"); f.store.retry("x", "unknown network failure");
  const target = f.store.get("x")!.status.delivery!.target;
  await f.clearance("L1"); await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.phase, "uncertain");
  assert.deepEqual(f.store.get("x")!.status.delivery!.target, target);
});

test("topic visibility follows the current Note subject and explicit Topic participants", async t => {
  const f = await setup(t); const n = await f.note("L1", "topic");
  const topic = await f.client.replace(f.topic, { ...f.topic.spec, people: personRefs([personRef(f.other) as PersonRef]) }, f.topic.status);
  f.output("x", n); await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.disclosure!.decision, "allowed");
  await f.client.replace(topic, { ...topic.spec, people: personRefs([]) }, topic.status);
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
  f.store.begin("x"); f.store.retry("x", "transport temporarily unavailable");
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

/** @case Classification can change without invalidating cited content; people visibility uses a union. */
test("Output policy combines current classifications and people across the cited Notes", async t => {
  const f = await setup(t); const a = await f.note("L1", "people", [personRef(f.me) as PersonRef]);
  const b = await f.note("L1", "people", [personRef(f.other) as PersonRef]);
  f.store.create("topic", "x", { ...outputSpec(f.topic, { topicId: "topic", text: a.spec.text, target: larkPersonAddress("app", "ou_c") }),
    notes: [a, b].map(n => ({ uid: n.metadata.uid, version: noteVersion(n) })) });
  await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.disclosure!.decision, "allowed");
  assert.deepEqual(f.store.get("x")!.status.disclosure!.policy?.people, [f.me.metadata.uid, f.other.metadata.uid].sort());
  await f.client.replace(a, { ...a.spec, sensitivity: "L3" }, a.status);
  await f.checker.reconcile("x");
  assert.match(f.store.get("x")!.status.disclosure!.reason, /sensitivity L3/);
  assert.doesNotMatch(f.store.get("x")!.status.disclosure!.reason, /changed since generation/);
});

/** @case A typed classification can be stored even when its current subject cannot yield a disclosure audience. */
test("Person-subject topic visibility falls back to Me during disclosure", async t => {
  const f = await setup(t);
  const note = await f.client.create(NOTE_TYPE, { name: "person-note", spec: { subject: personRef(f.other), text: "Profile fact", people: personRefs([]), sensitivity: "L1", visibility: "topic" }, status: { updatedAt: new Date().toISOString() } }) as NoteResource;
  f.output("person-scope", note); await f.checker.reconcile("person-scope");
  assert.equal(f.store.get("person-scope")!.status.disclosure!.decision, "denied");
  assert.deepEqual(f.store.get("person-scope")!.status.delivery!.target, webAddress("topic"));
});

/** @case A failed transport must not monopolize the real controller queue or require a Channel polling loop. */
test("real Runner isolates one Output's transport failure and automatically retries it", async t => {
  const { Aide } = await import("../src/app.ts");
  const { fakeOptions } = await import("./fake-harness.ts");
  const home = mkdtempSync(join(tmpdir(), "aide-output-retry-"));
  const aide = new Aide(home, { ...fakeOptions({ async execute() { throw new Error("No inference expected"); } }, home, [], home, "cli_test"),
    destinationAudience: async () => ({ identities: [LOCAL_ME], complete: true, private: true }) }, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  let attempts = 0;
  aide.registerOutputTransport(() => ({ replay: "idempotent", async send() { if (++attempts === 1) throw new Error("temporary send failure"); return undefined; } }));
  await aide.start(); await aide.topics.ensure("retry");
  const slow = await aide.topics.say("retry", undefined, "Retry this", undefined, { target: larkAddress("cli_test", "oc_me") });
  const ready = await aide.topics.say("retry", undefined, "Ready for Me");
  for (let i = 0; i < 200 && [slow, ready].some(x => aide.outputStore.get(x.outputId)!.status.phase !== "delivered"); i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(aide.outputStore.get(ready.outputId)!.status.phase, "delivered");
  assert.equal(aide.outputStore.get(slow.outputId)!.status.phase, "delivered");
  assert.equal(attempts, 2); assert.equal(aide.outputStore.get(slow.outputId)!.status.lastError, undefined);
});

/** @case Moving the subject under another root invalidates the cached scope without a separate authorization anchor. */
test("root visibility follows current parent relationships before delivery", async t => {
  const f = await setup(t);
  const { TOPIC_TYPE } = await import("../plugins/personal/topic/model.ts");
  const root = await f.client.create(TOPIC_TYPE, { name: "root", spec: { id: "root", people: [personRef(f.other)] }, status: {} });
  const attached = await f.client.replace(f.topic, { ...f.topic.spec, parentRef: resourceRef(root) }, f.topic.status);
  f.output("root-scope", await f.note("L1", "root"));
  await f.checker.reconcile("root-scope");
  assert.equal(f.store.get("root-scope")!.status.disclosure!.decision, "allowed");
  const { parentRef: _parent, ...detached } = attached.spec;
  await f.client.replace(attached, detached, attached.status);
  await f.checker.reconcile("root-scope");
  assert.equal(f.store.get("root-scope")!.status.disclosure!.decision, "denied");
});

test("policy aggregates mixed scopes in one place and does not turn an empty audience into public", async () => {
  const { disclosurePolicy } = await import("../plugins/personal/output/policy.ts");
  assert.deepEqual(disclosurePolicy([
    { sensitivity: "L1", visibility: "people", people: ["a"] },
    { sensitivity: "L3", visibility: "any", people: ["b"] },
  ]), { sensitivity: "L3", visibility: "people", people: ["a", "b"] });
  assert.deepEqual(disclosurePolicy([
    { sensitivity: "L1", visibility: "topic", people: [], topicPeople: ["a"] },
    { sensitivity: "L1", visibility: "topic", people: [], topicPeople: ["b"] },
  ])?.people, ["a", "b"]);
  assert.equal(disclosurePolicy([{ sensitivity: "L1", visibility: "root", people: [] }]), undefined);
  assert.deepEqual(disclosurePolicy([{ sensitivity: "L1", visibility: "people", people: [] }]), { sensitivity: "L1", visibility: "people", people: [] });
});

// @case Audience order and duplicates are not permission changes; membership still is.
test("audience permutations survive failed and interrupted idempotent delivery", async t => {
  for (const interrupted of [false, true]) {
    const f = await setup(t);
    f.audience({ people: [f.me, f.other], complete: true, private: false });
    f.output("x", await f.note());
    let sends = 0;
    const delivery = new OutputDelivery(f.store, () => ({ replay: "idempotent", send: async () => {
      if (++sends === 1) throw new Error("temporary failure");
      return { id: "receipt", scope: "test" };
    } }), pino({ level: "silent" }));
    await assert.rejects(delivery.reconcile("x"), /transport failed/);
    const fingerprint = f.store.get("x")!.status.disclosure!.fingerprint;
    if (interrupted) f.store.update("x", s => ({ ...s, phase: "sending" }));
    f.audience({ people: [f.other, f.me, f.other], complete: true, private: false });
    await delivery.reconcile("x");
    const result = f.store.get("x")!;
    assert.equal(result.status.phase, "delivered");
    assert.equal(result.status.attempts, 2);
    assert.equal(sends, 2);
    assert.equal(f.checks(), 1);
    assert.equal(result.status.disclosure!.fingerprint, fingerprint);
    assert.deepEqual(result.status.delivery!.receivers.toJSON().map(p => p.uid), [f.me.metadata.uid, f.other.metadata.uid].sort());
  }
});

test("audience reorder during asynchronous review does not invalidate the check", async t => {
  const f = await setup(t);
  f.audience({ people: [f.me, f.other], complete: true, private: false });
  f.output("x", await f.note());
  f.ports.check = async () => {
    f.audience({ people: [f.other, f.me, f.me], complete: true, private: false });
    return { allowed: true, reason: "supported" };
  };
  await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.disclosure!.decision, "allowed");
});

test("actual audience membership change stops a pending retry even when all recipients are allowed", async t => {
  const f = await setup(t);
  f.audience({ people: [f.me, f.other], complete: true, private: false });
  f.output("x", await f.note());
  let sends = 0;
  const delivery = new OutputDelivery(f.store, () => ({ replay: "idempotent", send: async () => { sends++; throw new Error("temporary failure"); } }), pino({ level: "silent" }));
  await assert.rejects(delivery.reconcile("x"), /transport failed/);
  f.audience({ people: [f.other], complete: true, private: false });
  await delivery.reconcile("x");
  assert.equal(f.store.get("x")!.status.phase, "uncertain");
  assert.equal(sends, 1);
});


test("rechecking changed evidence preserves the same recipient set after an attempt", async t => {
  const f = await setup(t), note = await f.note();
  f.audience({ people: [f.me, f.other], complete: true, private: false });
  f.output("x", note);
  await f.checker.reconcile("x");
  f.store.begin("x"); f.store.retry("x", "temporary failure");
  // Both policies permit this audience, but the classification change must produce a new check.
  await f.client.replace(note, { ...note.spec, visibility: "people", people: personRefs([personRef(f.other) as PersonRef]) }, note.status);
  f.audience({ people: [f.other, f.me, f.me], complete: true, private: false });
  await f.checker.reconcile("x");
  assert.equal(f.store.get("x")!.status.phase, "pending");
  assert.equal(f.store.get("x")!.status.disclosure!.policy!.visibility, "people");
  assert.equal(f.checks(), 2);
});

test("Output admission and immutable delivery compare Person UID sets on both sides", async t => {
  const f = await setup(t), a = personRef(f.me), b = personRef(f.other);
  const spec = { ...outputSpec(f.topic, { topicId: "topic", text: "fact", target: webAddress("topic") }), receivers: personRefs([b, a, b]) };
  let received: import("../plugins/personal/output/model.ts").Output | undefined;
  f.store.subscribe(value => { received = value; });
  const original = f.store.create("topic", "sets", spec);
  assert(received?.spec.receivers instanceof KeyedSet);
  assert.equal(received.spec.receivers.size, 2);
  received.spec.receivers.clear();
  const listed = f.store.list({ topicUid: f.topic.metadata.uid })[0]!;
  assert(listed.spec.receivers instanceof KeyedSet);
  assert.equal(listed.spec.receivers.size, 2);
  assert.deepEqual(f.store.create("topic", "sets", { ...spec, receivers: personRefs([a, b]) }), original);
  assert.throws(() => f.store.create("topic", "sets", { ...spec, receivers: personRefs([a]) }), /different content/);
  const previous = { ...original, spec, status: { phase: "pending" as const, attempts: 1,
    delivery: { target: spec.target, text: spec.text, receivers: personRefs([b, a, b]) } } };
  const current = { ...previous, spec: { ...spec, receivers: personRefs([a, b]) }, status: { ...previous.status,
    delivery: { ...previous.status.delivery, receivers: personRefs([a, b]) } } };
  const context = { get() { throw new Error("Unexpected lookup"); }, page() { throw new Error("Unexpected lookup"); }, list() { throw new Error("Unexpected lookup"); } };
  OutputDefinition.validator!.update!(previous, current, context);
  assert.throws(() => OutputDefinition.validator!.update!(previous, { ...current, status: { ...current.status,
    delivery: { ...current.status.delivery, receivers: personRefs([a]) } } }, context), /delivery is immutable/);
  assert.throws(() => OutputDefinition.validator!.update!(previous, { ...current, status: { ...current.status,
    delivery: { ...current.status.delivery, text: "different" } } }, context), /delivery is immutable/);
});
