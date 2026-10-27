import { assessInput } from "../plugins/personal/topic/assess.ts";
import { runInput, nextInputs } from "../plugins/personal/loop.ts";
import { InputAttention } from "../plugins/personal/input/model.ts";
import { registerWeave } from "../plugins/personal/weave/reconcile.ts";
import { candidatePage, weaveCandidates, candidateVersion } from "../plugins/personal/weave/candidates.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { PluginContext } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { WEAVE_TYPE, type WeaveStatus } from "../plugins/personal/weave/model.ts";
import { groupTopics } from "../plugins/personal/weave/service.ts";
import { TOPIC_TYPE, type TopicResource } from "../plugins/personal/topic/model.ts";
import { ensureSourceTopic, topicPath, understandingVersion } from "../plugins/personal/topic/tree.ts";
import { reconcileChief } from "../plugins/personal/topic/reconcile.ts";
import { collectTopic } from "../plugins/personal/topic/lifecycle.ts";
import { summarizeTopic, upsertTopicNote } from "../plugins/personal/topic/state.ts";
import { routeByRules } from "../plugins/personal/route/rules.ts";
import { topicCandidates } from "../plugins/personal/background.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
const logger = { debug() {}, info() {}, warn() {}, error() {} };
function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = mkdtempSync(join(tmpdir(), "aide-weave-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No inference"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const context = { resources, logger, instance: { config: { topic: { idleMs: 1000 } } } } as unknown as PluginContext;
  const weave = async () => (await resources.get<Record<string, never>, WeaveStatus>({ ...WEAVE_TYPE, namespace: "v1", name: "global" }))!;
  const initialize = () => resources.create(WEAVE_TYPE, { name: "global", spec: {}, status: {} });
  const refresh = (t: TopicResource) => aide.topics.resource(t.spec.id)!;
  const group = async (...topics: TopicResource[]) => groupTopics(resources, await weave(), {
    topics: topics.map(t => ({ uid: t.metadata.uid, version: understandingVersion(refresh(t)) })), name: "Shared subject", summary: "Preserved child findings",
  }, 4000);
  const input = async (id: string, key: string) => {
    const fact = await aide.topics.submit(id, { origin: "source", originId: "fixture", topicKey: key, text: id });
    await routeByRules(context, fact);
    return aide.topics.inputStore.get(id)!;
  };
  return { aide, resources, context, weave, initialize, refresh, group, input };
}

test("Weave reparents a running Chief immediately; materials and old Work stay while new Work belongs to the new root", async t => {
  const f = fixture(t); await f.initialize();
  const first = await f.input("first", "source:a");
  const a = f.aide.topics.byKey("source:a")!, b = await ensureSourceTopic(f.resources, "source:b", "B");
  await f.resources.replace(b, { ...b.spec, trigger: { enabled: false } }, b.status);
  const definition = { kind: "task" as const, title: "Check", instruction: "Check evidence", trigger: null };
  let task1 = "", task2 = "", rootPrompts = 0;
  const execution: any = { executionId: "old-chief", withContext() { return this; }, verbs: { async harness(args: any) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "native-a" } };
    task1 = (await f.aide.work(a.spec.id).create(definition, "first")).id;
    await groupTopics(f.resources, await f.weave(), { topics: [{ uid: a.metadata.uid, version: understandingVersion(f.refresh(a)) }],
      parent: { uid: b.metadata.uid, version: understandingVersion(f.refresh(b)) } }, 4000);
    assert.equal(f.refresh(a).status.execution?.id, "old-chief");
    assert.equal(f.refresh(a).spec.parentRef?.uid, b.metadata.uid);
    assert.deepEqual(f.aide.topics.inputStore.get("first")!.status.assess, first.status.assess, "Weave and Chief activation never claim Input");
    await f.input("second", "source:a");
    const rootExecution: any = { executionId: "root-chief", withContext() { return this; }, verbs: { async harness(message: any) {
      if (message.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "native-b" } };
      rootPrompts++;
      task2 = (await f.aide.work(b.spec.id).create(definition, "second")).id;
      assert.ok(f.aide.work(b.spec.id).list().some(w => w.id === task1));
      await assessInput(f.resources, f.refresh(b), "root-chief", { inputId: "second", summary: "Follow up" });
      return { state: "success", value: { result: { stopReason: "end_turn" } } };
    } } };
    await reconcileChief(f.context, rootExecution, f.refresh(b));
    await assessInput(f.resources, f.refresh(a), "old-chief", { inputId: "first", summary: "Old Chief finished naturally" });
    const current = f.refresh(a);
    await summarizeTopic(f.resources, current, "old-chief", { version: current.metadata.resourceVersion, summary: "Late finding" }, 4000);
    const afterSummary = f.refresh(a);
    await upsertTopicNote(f.resources, afterSummary, "old-chief", { version: afterSummary.metadata.resourceVersion, text: "Late progress from the draining Chief" }, "late-note");
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } };
  await runInput(f.context, execution, f.refresh(a), "chief", "Review first", "first");
  assert.equal(rootPrompts, 1);
  assert.equal(f.aide.works().find(w => w.id === task1)!.topicId, a.spec.id);
  assert.equal(f.aide.works().find(w => w.id === task2)!.topicId, b.spec.id);
  assert.equal(f.refresh(b).spec.trigger?.enabled, false, "existing parent keeps its trigger policy");
  assert.equal(f.refresh(a).status.summary, "Late finding");
  assert.equal(f.refresh(a).status.recent[0]?.text, "Late progress from the draining Chief");
  assert.equal(f.refresh(a).status.execution, null);
  for (const id of ["first", "second"]) {
    const input = f.aide.topics.inputStore.get(id)!;
    assert.deepEqual(input.status.route!.result!.topics, [resourceRef(a)]);
    assert.deepEqual(Object.keys(input.status.assess!), [a.metadata.uid]);
    assert.equal(input.status.assess![a.metadata.uid]!.executionId, undefined);
  }
  assert.deepEqual(await nextInputs(f.resources, f.refresh(a), 8), [], "child cannot start a new Chief");
  assert.deepEqual(topicCandidates(f.aide.personal.store).map(c => c.uid), [b.metadata.uid]);
});

test("Weave rejects stale understanding and cycles but does not wait for uncertain Chief effects", async t => {
  const f = fixture(t); await f.initialize();
  const a = await ensureSourceTopic(f.resources, "a", "A"), b = await ensureSourceTopic(f.resources, "b", "B");
  const stale = { topics: [a, b].map(t => ({ uid: t.metadata.uid, version: understandingVersion(t) })), name: "Shared", summary: "Old facts" };
  await f.resources.patchStatus(f.refresh(a), { summary: "A late finding", lastError: "Inspect prior effects" });
  await assert.rejects(groupTopics(f.resources, await f.weave(), stale, 4000), /understanding changed/);
  await f.group(a, b);
  const parent = f.aide.topics.resource(f.aide.topics.list().find(t => !t.parentRef)!.id)!;
  await assert.rejects(f.resources.replace(parent, { ...parent.spec, parentRef: resourceRef(a) }, parent.status), /cycle/);
  assert.equal(f.refresh(a).status.lastError, "Inspect prior effects");
});

test("Topic expiry checks child absorption, releases source key, and never revives an old routed Input", async t => {
  const f = fixture(t); await f.initialize();
  const fact = await f.input("old", "a"), a = f.aide.topics.byKey("a")!, b = await ensureSourceTopic(f.resources, "b", "B");
  await f.resources.patchStatus(fact, { assess: { [a.metadata.uid]: { ...fact.status.assess![a.metadata.uid]!, completedAt: new Date().toISOString() } } });
  await f.group(a, b);
  const parent = f.aide.topics.list().find(t => !t.parentRef)!;
  await f.resources.patchStatus(f.refresh(a), { summary: "Changed child finding", lastInputAt: "2000-01-01T00:00:00.000Z" });
  await collectTopic(f.context, f.refresh(a));
  assert.ok(f.aide.topics.resource(a.spec.id), "unabsorbed child survives");
  await f.resources.patchStatus(f.aide.topics.resource(parent.id)!, { execution: { id: "synthesis", startedAt: new Date().toISOString() } });
  const p = f.aide.topics.resource(parent.id)!;
  await summarizeTopic(f.resources, p, "synthesis", { version: p.metadata.resourceVersion, summary: "Changed child finding retained",
    absorbed: [{ uid: a.metadata.uid, version: understandingVersion(f.refresh(a)) }] }, 4000);
  await collectTopic(f.context, f.refresh(a));
  assert.equal(f.aide.topics.resource(a.spec.id), undefined);
  assert.equal(f.aide.topics.byKey("a"), undefined);
  await routeByRules(f.context, fact);
  assert.equal(f.aide.topics.byKey("a"), undefined);
  await f.input("new", "a");
  assert.notEqual(f.aide.topics.byKey("a")!.metadata.uid, a.metadata.uid);
  assert.equal(f.aide.topics.byKey("a")!.spec.parentRef, undefined);
  const fallback = await f.aide.topics.ensure("default");
  await assert.rejects(f.group(f.aide.topics.resource("default")!, b), /non-Default roots/);
  await assert.rejects(f.resources.delete(TOPIC_TYPE, fallback.metadata.name), /cannot be deleted/);
});

test("Nested Weave preserves the leaf path and propagates actual Input activity to every ancestor", async t => {
  const f = fixture(t); await f.initialize();
  const a = await ensureSourceTopic(f.resources, "a", "A"), b = await ensureSourceTopic(f.resources, "b", "B");
  await f.group(a, b);
  const parent = f.aide.topics.list().find(t => !t.parentRef)!;
  const c = await ensureSourceTopic(f.resources, "c", "C");
  await f.group(f.aide.topics.resource(parent.id)!, c);
  const input = await f.input("fresh", "a");
  const all = await f.resources.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE);
  const path = topicPath(all, f.refresh(a));
  assert.equal(path.length, 3);
  assert.equal(new Set(path.map(t => t.status.lastInputAt)).size, 1);
  assert.deepEqual(Object.keys(input.status.assess!), [a.metadata.uid]);
  const cyclic = f.refresh(path[2]!);
  await assert.rejects(f.resources.replace(cyclic, { ...cyclic.spec, parentRef: resourceRef(a) }, cyclic.status), /cycle/);
});

test("Weave groups a large backlog without moving any Input or batching migrations", async t => {
  const f = fixture(t); await f.initialize();
  for (let n = 0; n < 120; n++) await f.input(`burst-${n}`, "burst");
  const a = f.aide.topics.byKey("burst")!, b = await ensureSourceTopic(f.resources, "peer", "Peer");
  const before = f.aide.topics.inputStore.list();
  await f.group(a, b);
  assert.deepEqual(f.aide.topics.inputStore.list(), before);
  const root = f.aide.topics.resource(f.aide.topics.list().find(t => !t.parentRef)!.id)!;
  assert.equal(f.aide.topics.pending(root.metadata.uid).length, 120);
  assert.equal(f.aide.topics.pending(a.metadata.uid).length, 120);
  assert.equal((await nextInputs(f.resources, root, 8)).length, 8);
  await f.input("later", "burst");
  assert.deepEqual(Object.keys(f.aide.topics.inputStore.get("later")!.status.assess!), [a.metadata.uid]);
});

test("Weave advances only the bounded snapshot and retries interrupted analysis", async t => {
  const f = fixture(t); await f.initialize();
  for (let i = 0; i < 24; i++) {
    const topic = await ensureSourceTopic(f.resources, `page:${i}`, "name");
    await f.resources.replace(topic, { ...topic.spec, name: "n".repeat(200) }, { ...topic.status, summary: "s".repeat(1200) });
  }
  const roots = weaveCandidates(await f.resources.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE));
  assert.ok(candidatePage(roots, 0, 12).items.length < 12);
  let reconcile!: (execution: any, owner: any) => Promise<unknown>;
  const context = { ...f.context, instance: { config: { weave: { intervalMs: 1000 } } }, controllers: { register(def: any) { reconcile = def.reconcile; } } } as unknown as PluginContext;
  registerWeave(context);
  const seen = new Set<string>();
  let fail = true;
  const execution = { executionId: "scan", verbs: { async harness(args: any) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "weave", sessionId: "native" } };
    if (fail) return { state: "failure", error: "interrupted" };
    const batch = JSON.parse(args.prompt.split("\n").at(-1));
    batch.items.forEach((item: any) => seen.add(item.uid));
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } };
  await reconcile(execution, await f.weave());
  assert.deepEqual((await f.weave()).status.reviewed, {});
  fail = false;
  for (let i = 0; i < 3; i++) {
    await f.resources.patchStatus(await f.weave(), { nextAt: "2000-01-01T00:00:00.000Z" });
    await reconcile(execution, await f.weave());
    assert.equal(Object.keys((await f.weave()).status.reviewed ?? {}).length, seen.size);
    await f.resources.patchStatus(f.refresh(roots[0]!), { summary: `Changed material ${i}`, lastInputAt: new Date().toISOString() });
  }
  assert.equal(seen.size, 24);
  await f.resources.patchStatus(f.refresh(roots[0]!), { summary: "changed during scan" });
  await f.resources.patchStatus(await f.weave(), { nextAt: "2000-01-01T00:00:00.000Z" });
  await reconcile(execution, await f.weave());
  assert.equal(Object.keys((await f.weave()).status.reviewed ?? {}).length, 24, "a changed Topic does not reset other progress");
});

test("A quiet changed child wakes root synthesis without Input and can then expire", async t => {
  const f = fixture(t); await f.initialize();
  const a = await ensureSourceTopic(f.resources, "absorb:a", "A"), b = await ensureSourceTopic(f.resources, "absorb:b", "B");
  await f.group(a, b);
  const root = f.aide.topics.list().find(t => !t.parentRef)!;
  await f.resources.patchStatus(f.aide.topics.resource(root.id)!, { notifiedWeaveRevision: 1 });
  await f.resources.patchStatus(f.refresh(a), { summary: "New evidence", lastInputAt: "2000-01-01T00:00:00.000Z" });
  const before = f.aide.topics.resource(root.id)!.status.lastInputAt;
  let prompts = 0;
  const execution: any = { executionId: "absorb", withContext() { return this; }, verbs: { async harness(args: any) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "native" } };
    prompts++;
    assert.match(args.prompt, /"kind":"absorb"/);
    const current = f.aide.topics.resource(root.id)!;
    await summarizeTopic(f.resources, current, "absorb", { version: current.metadata.resourceVersion, summary: "New evidence retained",
      absorbed: [{ uid: a.metadata.uid, version: understandingVersion(f.refresh(a)) }] }, 4000);
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } };
  await reconcileChief(f.context, execution, f.aide.topics.resource(root.id)!);
  assert.equal(prompts, 1);
  assert.equal(f.aide.topics.inputs().length, 0);
  assert.equal(f.aide.topics.resource(root.id)!.status.lastInputAt, before);
  await collectTopic(f.context, f.refresh(a));
  assert.equal(f.aide.topics.resource(a.spec.id), undefined);
  await reconcileChief(f.context, execution, f.aide.topics.resource(root.id)!);
  assert.equal(prompts, 1);
});

test("Root Chief admits a bounded backlog with urgent Input first and independent receipts", async t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) await f.input(`batch-${i}`, "batch");
  const root = f.aide.topics.byKey("batch")!;
  const urgent = await f.aide.topics.submit("urgent", { origin: "channel", originId: "web", topicKey: "batch", attention: InputAttention.Immediate, text: "urgent question" });
  await routeByRules(f.context, urgent);
  let prompts = 0;
  const execution: any = { executionId: "batch", withContext() { return this; }, verbs: { async harness(args: any) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "native" } };
    prompts++;
    const activation = JSON.parse(args.prompt.split("Activation: ")[1].split("\n")[0]);
    assert.equal(activation.inputs.length, 8);
    assert.equal(activation.inputs[0].inputId, "urgent");
    for (const item of activation.inputs) {
      const fact = f.aide.topics.inputStore.get(item.inputId)!;
      assert.ok(f.refresh(root).status.notifiedInputs?.includes(fact.metadata.uid));
      assert.equal(fact.status.assess![root.metadata.uid]!.executionId, undefined);
      await f.resources.patchStatus(fact, { assess: { ...fact.status.assess, [root.metadata.uid]: { ...fact.status.assess![root.metadata.uid]!, completedAt: new Date().toISOString() } } });
    }
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } };
  await reconcileChief(f.context, execution, f.refresh(root));
  assert.equal(prompts, 1);
  assert.equal(f.aide.topics.pending(root.metadata.uid).length, 3);
  assert.ok(f.aide.topics.pending(root.metadata.uid).every(i => !i.status.assess![root.metadata.uid]!.executionId));
});


test("Unfinished synthesis backs off without inventing Input or refreshing activity", async t => {
  const f = fixture(t); await f.initialize();
  const a = await ensureSourceTopic(f.resources, "retry:a", "A"), b = await ensureSourceTopic(f.resources, "retry:b", "B");
  await f.group(a, b);
  const root = f.aide.topics.list().find(t => !t.parentRef)!;
  await f.resources.patchStatus(f.aide.topics.resource(root.id)!, { notifiedWeaveRevision: 1 });
  await f.resources.patchStatus(f.refresh(a), { summary: "Awaiting synthesis" });
  let prompts = 0;
  const execution: any = { executionId: "retry", withContext() { return this; }, verbs: { async harness(args: any) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "native" } };
    prompts++;
    return { state: "failure", error: "unavailable" };
  } } };
  await reconcileChief(f.context, execution, f.aide.topics.resource(root.id)!);
  await reconcileChief(f.context, execution, f.aide.topics.resource(root.id)!);
  assert.equal(prompts, 1);
  assert.equal(f.aide.topics.resource(root.id)!.status.absorbAttempts, 1);
  await f.resources.patchStatus(f.aide.topics.resource(root.id)!, { nextAbsorbAt: "2000-01-01T00:00:00.000Z" });
  await reconcileChief(f.context, execution, f.aide.topics.resource(root.id)!);
  assert.equal(prompts, 2);
  assert.equal(f.aide.topics.resource(root.id)!.status.absorbAttempts, 2);
  assert.ok(Date.parse(f.aide.topics.resource(root.id)!.status.nextAbsorbAt!) > Date.now() + 110_000);
  assert.equal(f.aide.topics.inputs().length, 0);
});

/** @case Grouping retains recent matters with their stable identities instead of moving progress into parent summary. */
test("Weave carries bounded child Notes into the parent while keeping a durable parent summary", async t => {
  const f = fixture(t); await f.initialize();
  const a = await ensureSourceTopic(f.resources, "note:a", "A"), b = await ensureSourceTopic(f.resources, "note:b", "B");
  const note = { id: "verification-progress", createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T01:00:00Z", text: "A reports verification is 50% complete" };
  const version = candidateVersion(a);
  await f.resources.patchStatus(a, { recent: [note] });
  assert.equal(candidateVersion(f.refresh(a)), version, "Note-only changes do not restart the stable-topic scan");
  await f.group(f.refresh(a), b);
  const parent = f.aide.topics.resource(f.aide.topics.list().find(topic => !topic.parentRef)!.id)!;
  assert.deepEqual(parent.status.recent, [note]);
  assert.equal(parent.status.summary, "Preserved child findings");
  assert.ok(parent.status.absorbedSummaries?.[a.metadata.uid]);
});
