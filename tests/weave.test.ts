import { topicTools } from "../plugins/personal/chief/agent/topic-tools.ts";
import { reclamationVersion } from "../plugins/personal/topic/retention.ts";
import { selectChiefIntake } from "../plugins/personal/chief/intake.ts";
import { isRootTopic } from "../plugins/personal/topic/boundary.ts";
import { newHarnessError } from "@compforge/aide-plugin";
import { summaryText } from "../plugins/personal/note/summary.ts";
import { patchSummary } from "./summary-fixture.ts";
import { assignInput } from "../plugins/personal/input/assignment.ts";
import { seedNotes } from "./fixtures/notes.ts";
import { notes } from "../plugins/personal/note/query.ts";
import { contentVersion } from "../plugins/personal/context-write.ts";
import { continueTopicSession, deliverInput } from "./input-state-fixture.ts";
import { runInput } from "../plugins/personal/execution/loop.ts";
import { preparedInputs as nextInputs } from "../plugins/personal/chief/queue.ts";
import { InputAttention } from "../plugins/personal/input/model.ts";
import { registerWeave } from "../plugins/personal/weave/reconcile.ts";
import { candidatePage, weaveCandidates, candidateVersion, searchRootTopics } from "../plugins/personal/weave/candidates.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { reconcileChief } from "../plugins/personal/chief/reconcile.ts";
import { collectTopic } from "../plugins/personal/chief/session.ts";
import { upsertTopicNote } from "../plugins/personal/topic/state.ts";
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
  const reviewed = () => Object.fromEntries(aide.topics.resources.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE)
    .filter(t => isRootTopic(t) && t.status.weaveReview).map(t => [t.metadata.uid, t.status.weaveReview!]));
  const mark = async (entries: Record<string, { version: string; at: string }>) => {
    for (const topic of aide.topics.resources.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE))
      if (entries[topic.metadata.uid]) await resources.patchStatus(topic, { weaveReview: entries[topic.metadata.uid] });
  };
  return { aide, resources, context, weave, initialize, refresh, group, input, reviewed, mark };
}

test("Weave reparents a running Chief immediately; materials and old Work stay while new Work belongs to the new root", async t => {
  const f = fixture(t); await f.initialize();
  const first = await f.input("first", "source:a");
  const a = f.aide.topics.byKey("source:a")!, b = await ensureSourceTopic(f.resources, "source:b", "B");
  await f.resources.replace(b, { ...b.spec, review: { enabled: false } }, b.status);
  const definition = { kind: "task" as const, title: "Check", instruction: "Check evidence", trigger: null };
  let task1 = "", task2 = "", rootPrompts = 0;
  const execution: any = { executionId: "old-chief", withContext() { return this; }, verbs: { action: continueTopicSession, async harness(args: any) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "native-a" } };
    task1 = (await f.aide.work(a.spec.id).create(definition, "first")).id;
    await groupTopics(f.resources, await f.weave(), { topics: [{ uid: a.metadata.uid, version: understandingVersion(f.refresh(a)) }],
      parent: { uid: b.metadata.uid, version: understandingVersion(f.refresh(b)) } }, 4000);
    assert.equal(f.refresh(a).status.execution?.id, "old-chief");
    assert.equal(f.refresh(a).spec.parentRef?.uid, b.metadata.uid);
    assert.equal(f.aide.topics.inputStore.get("first")!.status.assess?.executionId, "old-chief", "Weave preserves the original admission");
    await f.input("second", "source:a");
    const rootExecution: any = { executionId: "root-chief", withContext() { return this; }, verbs: { action: continueTopicSession, async harness(message: any) {
      if (message.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "native-b" } };
      rootPrompts++;
      task2 = (await f.aide.work(b.spec.id).create(definition, "second")).id;
      assert.ok(f.aide.work(b.spec.id).list().some(w => w.id === task1));
      await deliverInput(f.resources, f.refresh(b), "root-chief", "second");
      return { state: "success", value: { result: { stopReason: "end_turn" } } };
    } } };
    await selectChiefIntake(f.context, f.refresh(b));
    await reconcileChief(f.context, rootExecution, f.refresh(b));
    await deliverInput(f.resources, f.refresh(a), "old-chief", "first");
    const current = f.refresh(a);
    await upsertTopicNote(f.resources, current, "old-chief", { summaryOf: resourceRef(current), version: contentVersion(current), text: "Late finding" }, "summary", 4000, "aide:summary");
    const afterSummary = f.refresh(a);
    await upsertTopicNote(f.resources, afterSummary, "old-chief", { nature: "semantic", version: afterSummary.metadata.resourceVersion, text: "Late progress from the draining Chief" }, "late-note");
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } };
  await runInput(f.context, execution, f.refresh(a), "chief", "Review first", "first");
  assert.equal(rootPrompts, 1);
  assert.equal(f.aide.works().find(w => w.id === task1)!.topicId, a.spec.id);
  assert.equal(f.aide.works().find(w => w.id === task2)!.topicId, b.spec.id);
  assert.equal(f.refresh(b).spec.review?.enabled, false, "existing parent keeps its review policy");
  assert.equal(summaryText(f.aide.topics.resources, f.refresh(a)), "Late finding");
  assert.equal(notes(f.aide.topics.resources, a.metadata.uid, "subject")[0]?.text, "Late progress from the draining Chief");
  assert.equal(f.refresh(a).status.execution, null);
  for (const id of ["first", "second"]) {
    const input = f.aide.topics.inputStore.get(id)!;
    assert.deepEqual(input.status.route!.result!.topics, [resourceRef(a)]);
    assert.ok(input.status.assess);
    assert.equal(input.status.assess!.executionId, id === "first" ? "old-chief" : "root-chief");
  }
  assert.deepEqual(await nextInputs(f.resources, f.refresh(a), 8), [], "child cannot start a new Chief");
  assert.deepEqual(topicCandidates(f.aide.personal.store).map(c => c.metadata.uid), [b.metadata.uid]);
});

test("Weave rejects stale understanding and cycles but does not wait for uncertain Chief effects", async t => {
  const f = fixture(t); await f.initialize();
  const a = await ensureSourceTopic(f.resources, "a", "A"), b = await ensureSourceTopic(f.resources, "b", "B");
  const stale = { topics: [a, b].map(t => ({ uid: t.metadata.uid, version: understandingVersion(t) })), name: "Shared", summary: "Old facts" };
  await patchSummary(f.resources, f.refresh(a), { summary: "A late finding", lastError: "Inspect prior effects" });
  await assert.rejects(groupTopics(f.resources, await f.weave(), stale, 4000), /understanding changed/);
  await f.group(a, b);
  const parent = f.aide.topics.resource(f.aide.topics.list().find(t => isRootTopic({ spec: t }))!.id)!;
  await assert.rejects(f.resources.replace(parent, { ...parent.spec, parentRef: resourceRef(a) }, parent.status), /cycle/);
  assert.equal(f.refresh(a).status.lastError, "Inspect prior effects");
});

test("Explicit Topic deletion checks explicit child release, releases source key, and never revives an old routed Input", async t => {
  const f = fixture(t); await f.initialize();
  const fact = await f.input("old", "a"), a = f.aide.topics.byKey("a")!, b = await ensureSourceTopic(f.resources, "b", "B");
  await f.resources.patchStatus(fact, { assess: { ...fact.status.assess, completedAt: new Date().toISOString() } });
  await f.group(a, b);
  const parent = f.aide.topics.list().find(t => isRootTopic({ spec: t }))!;
  await patchSummary(f.resources, f.refresh(a), { summary: "Changed child finding", lastInputAt: "2000-01-01T00:00:00.000Z" });
  await collectTopic(f.context, f.refresh(a));
  assert.ok(f.aide.topics.resource(a.spec.id), "knowledge survives");
  await f.resources.patchStatus(f.aide.topics.resource(parent.id)!, { execution: { id: "synthesis", startedAt: new Date().toISOString() } });
  const p = f.aide.topics.resource(parent.id)!;
  await assert.rejects(f.resources.delete(TOPIC_TYPE, a.metadata.name), /Release this Topic/);
  const release = topicTools(f.aide.personal.store, () => p).find(tool => tool.name === "release_topic")!;
  await release.execute("release", { uid: a.metadata.uid, version: reclamationVersion(f.refresh(a), f.aide.topics.resources), reason: "Knowledge saved elsewhere" }, undefined, undefined, {} as never);
  await collectTopic(f.context, f.refresh(a));
  assert.ok(f.aide.topics.resource(a.spec.id), "silence retains the Topic until capacity or explicit deletion");
  await f.resources.delete(TOPIC_TYPE, a.metadata.name, "v1", { uid: a.metadata.uid, resourceVersion: f.refresh(a).metadata.resourceVersion });
  assert.equal(f.aide.topics.resource(a.spec.id), undefined);
  assert.equal(f.aide.topics.byKey("a"), undefined);
  await routeByRules(f.context, fact);
  assert.equal(f.aide.topics.byKey("a"), undefined);
  await f.input("new", "a");
  assert.notEqual(f.aide.topics.byKey("a")!.metadata.uid, a.metadata.uid);
  assert.ok(isRootTopic(f.aide.topics.byKey("a")!));
  const fallback = await f.aide.topics.ensure("default");
  await assert.rejects(f.group(f.aide.topics.resource("default")!, b), /non-Default roots/);
  await assert.rejects(f.resources.delete(TOPIC_TYPE, fallback.metadata.name), /cannot be deleted/);
});

test("Nested Weave preserves the leaf path and propagates actual Input activity to every ancestor", async t => {
  const f = fixture(t); await f.initialize();
  const a = await ensureSourceTopic(f.resources, "a", "A"), b = await ensureSourceTopic(f.resources, "b", "B");
  await f.group(a, b);
  const parent = f.aide.topics.list().find(t => isRootTopic({ spec: t }))!;
  const c = await ensureSourceTopic(f.resources, "c", "C");
  await f.group(f.aide.topics.resource(parent.id)!, c);
  const input = await f.input("fresh", "a");
  const all = await f.resources.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE);
  const path = topicPath(all, f.refresh(a));
  assert.equal(path.length, 3);
  assert.equal(new Set(path.map(t => t.status.lastInputAt)).size, 1);
  assert.ok(input.status.assess);
  const cyclic = f.refresh(path[2]!);
  await assert.rejects(f.resources.replace(cyclic, { ...cyclic.spec, parentRef: resourceRef(a) }, cyclic.status), /cycle/);
});

test("Weave groups a large backlog without moving any Input or batching migrations", { timeout: 15000 }, async t => {
  const f = fixture(t); await f.initialize();
  for (let n = 0; n < 120; n++) await f.input(`burst-${n}`, "burst");
  const a = f.aide.topics.byKey("burst")!, b = await ensureSourceTopic(f.resources, "peer", "Peer");
  const before = f.aide.topics.inputStore.list();
  await f.group(a, b);
  assert.deepEqual(f.aide.topics.inputStore.list(), before);
  const root = f.aide.topics.resource(f.aide.topics.list().find(t => isRootTopic({ spec: t }))!.id)!;
  assert.equal(f.aide.topics.pending(root.metadata.uid).length, 120);
  assert.equal(f.aide.topics.pending(a.metadata.uid).length, 120);
  // The Input controller converges assignment after the structural transaction, without moving material.
  for (const input of before) await assignInput({ resources: f.resources, logger: { info() {} } } as any, input);
  assert.equal((await nextInputs(f.resources, root, 8)).length, 8);
  await f.input("later", "burst");
  assert.equal(f.aide.topics.inputStore.get("later")!.status.assess!.topic!.uid, root.metadata.uid);
});

test("Weave advances only the bounded snapshot and retries interrupted analysis", async t => {
  const f = fixture(t); await f.initialize();
  for (let i = 0; i < 24; i++) {
    const topic = await ensureSourceTopic(f.resources, `page:${i}`, "name");
    const renamed = await f.resources.replace(topic, { ...topic.spec, name: "n".repeat(200) }, topic.status);
    await patchSummary(f.resources, renamed, { summary: "s".repeat(1200) });
  }
  const roots = weaveCandidates(await f.resources.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE));
  assert.ok(candidatePage(roots, 0, 12, undefined, t => summaryText(f.aide.topics.resources, t)).items.length < 12);
  let reconcile!: (execution: any, owner: any) => Promise<unknown>;
  const context = { ...f.context, instance: { config: { weave: { intervalMs: 1000 } } }, controllers: { register(def: any) { reconcile = def.reconcile; } } } as unknown as PluginContext;
  registerWeave(context);
  const seen = new Set<string>();
  let fail = true;
  const execution = { executionId: "scan", verbs: { async harness(args: any) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "weave", sessionId: "native" } };
    if (args.operation === "close") return { state: "success", value: { outcome: "accepted" } };
    if (fail) throw newHarnessError("harness_execution_failed", "interrupted");
    const batch = JSON.parse(args.prompt.split("\n").at(-1));
    batch.candidates.forEach((item: any) => seen.add(item.uid));
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } };
  await reconcile(execution, await f.weave());
  assert.deepEqual(f.reviewed(), {});
  fail = false;
  for (let i = 0; i < roots.length && seen.size < roots.length; i++) {
    await f.resources.patchStatus(await f.weave(), { nextAt: "2000-01-01T00:00:00.000Z" });
    await reconcile(execution, await f.weave());
    assert.equal(Object.keys(f.reviewed() ?? {}).length, seen.size);
    await patchSummary(f.resources, f.refresh(roots[0]!), { summary: `Changed material ${i}`, lastInputAt: new Date().toISOString() });
  }
  assert.equal(seen.size, 24);
  await patchSummary(f.resources, f.refresh(roots[0]!), { summary: "changed during scan" });
  await f.resources.patchStatus(await f.weave(), { nextAt: "2000-01-01T00:00:00.000Z" });
  await reconcile(execution, await f.weave());
  assert.equal(Object.keys(f.reviewed() ?? {}).length, 24, "a changed Topic does not reset other progress");
});



test("Root Chief admits urgent and observed business as separate bounded tasks with independent receipts", async t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) await f.input(`batch-${i}`, "batch");
  const root = f.aide.topics.byKey("batch")!;
  const urgent = await f.aide.topics.submit("urgent", { origin: "channel", originId: "lark", topicKey: "batch", attention: InputAttention.Immediate, text: "urgent question" });
  await routeByRules(f.context, urgent);
  let prompts = 0;
  const execution: any = { executionId: "batch", withContext() { return this; }, verbs: { async action() { return { state: "success", value: { streaming: false } }; }, async harness(args: any) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "native" } };
    prompts++;
    const activation = JSON.parse(args.prompt.split("Activation: ")[1].split("\n")[0]);
    assert.equal(activation.inputs.length, 1);
    if (prompts === 1) assert.equal(activation.inputs[0].inputId, "urgent");
    for (const item of activation.inputs) {
      const fact = f.aide.topics.inputStore.get(item.inputId)!;
      assert.equal(fact.status.assess?.executionId, execution.executionId);
      await f.resources.patchStatus(fact, { assess: { ...fact.status.assess, completedAt: new Date().toISOString() } });
    }
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } };
  await reconcileChief(f.context, execution, f.refresh(root));
  assert.equal(prompts, 1);
  assert.equal(f.aide.topics.pending(root.metadata.uid).length, 10);
  assert.ok(f.aide.topics.pending(root.metadata.uid).every(i => !i.status.assess!.executionId));
  for (let i = 0; i < 10; i++) await reconcileChief(f.context, execution, f.refresh(root));
  assert.equal(prompts, 11);
  assert.equal(f.aide.topics.pending(root.metadata.uid).length, 0);
});


test("Unfinished synthesis retries one review Input without refreshing business activity", async t => {
  const f = fixture(t); await f.initialize();
  const a = await ensureSourceTopic(f.resources, "retry:a", "A"), b = await ensureSourceTopic(f.resources, "retry:b", "B");
  const lastInputAt = new Date().toISOString();
  await f.group(await f.resources.patchStatus(a, { lastInputAt }), b);
  const root = f.aide.topics.list().find(t => isRootTopic({ spec: t }))!;
  await patchSummary(f.resources, f.refresh(a), { summary: "Changed after grouping" });
  let prompts = 0;
  const execution: any = { executionId: "retry", withContext() { return this; }, verbs: { action: continueTopicSession, async harness(args: any) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "native" } };
    prompts++;
    throw newHarnessError("harness_execution_failed", "unavailable");
  } } };
  await selectChiefIntake(f.context, f.aide.topics.resource(root.id)!);
  await reconcileChief(f.context, execution, f.aide.topics.resource(root.id)!);
  await selectChiefIntake(f.context, f.aide.topics.resource(root.id)!);
  await reconcileChief(f.context, execution, f.aide.topics.resource(root.id)!);
  assert.equal(prompts, 1);
  assert.equal(f.aide.topics.resource(root.id)!.status.maintenanceChecks?.["aide:curate"]?.attempts, 1);
  const pending = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:curate")!;
  await f.resources.patchStatus(pending, { assess: { ...pending.status.assess, errorAt: "2000-01-01T00:00:00.000Z" } });
  await selectChiefIntake(f.context, f.aide.topics.resource(root.id)!);
  await reconcileChief(f.context, execution, f.aide.topics.resource(root.id)!);
  assert.equal(prompts, 2);
  assert.equal(f.aide.topics.resource(root.id)!.status.lastInputAt, lastInputAt);
  assert.equal(f.aide.topics.resource(root.id)!.status.maintenanceChecks?.["aide:curate"]?.attempts, 1);
  assert.equal(f.aide.topics.inputStore.list().length, 1);
  assert.equal(f.aide.topics.inputStore.list()[0]!.metadata.uid, pending.metadata.uid);
  assert.ok(f.aide.topics.inputStore.list().every(i => i.spec.origin === "aide:curate"));
});

/** @case Grouping retains recent matters with their stable identities instead of moving progress into parent summary. */
test("Weave retains independent child Notes without copying them into the parent", async t => {
  const f = fixture(t); await f.initialize();
  const a = await f.aide.topics.ensure("noted-a"), b = await f.aide.topics.ensure("noted-b");
  await seedNotes(f.resources, a, [{ id: "evidence", text: "Child evidence" }]);
  const currentA = f.aide.topics.resource("noted-a")!;
  for (const page of [candidatePage([currentA], 0, 12), searchRootTopics([currentA], undefined, 0, 12)]) {
    assert.equal(page.items[0]!.uid, currentA.metadata.uid);
    assert.equal("version" in page.items[0]!, false, "Discovery cannot supply a version that omits unread Notes");
  }
  const currentB = f.aide.topics.resource("noted-b")!;
  const grouped = await groupTopics(f.resources, await f.weave(), { name: "Shared", summary: "Durable", topics: [currentA, currentB].map(t => ({ uid: t.metadata.uid, version: understandingVersion(t, notes(f.aide.topics.resources, t.metadata.uid, "subject")) })) }, 4000);
  const parent = f.aide.topics.resources.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE).find(t => t.metadata.uid === grouped.parentUid)!;
  assert.equal(summaryText(f.aide.topics.resources, parent), "Durable");
  assert.equal(notes(f.aide.topics.resources, parent.metadata.uid, "subject").length, 0);
  assert.equal(notes(f.aide.topics.resources, a.metadata.uid, "subject")[0]!.text, "Child evidence");
});

/** @case Old view receipts are rechecked once, with a fresh session for each bounded batch. */
test("Weave replaces legacy checks and sessions without repeatedly resetting coverage", async t => {
  const f = fixture(t); await f.initialize();
  const roots = await Promise.all(["one", "two", "three"].map(key => ensureSourceTopic(f.resources, key, key)));
  const at = "2000-01-01T00:00:00.000Z";
  const legacy = Object.fromEntries(roots.map(topic => [topic.metadata.uid, { at,
    version: createHash("sha256").update(JSON.stringify([topic.spec.name, createHash("sha256").update("").digest("hex")])).digest("hex") }]));
  await f.mark(legacy);
  await f.resources.patchStatus(await f.weave(), { agent: { harness: "weave", sessionId: "obsolete-rules" } });
  let reconcile!: (execution: any, owner: any) => Promise<unknown>;
  registerWeave({ ...f.context, instance: { config: { weave: { intervalMs: 1000, batchSize: 2 } } },
    controllers: { register(def: any) { reconcile = def.reconcile; } } } as unknown as PluginContext);
  const closed: string[] = [], prompts: any[] = [];
  let created = 0;
  const execution = { executionId: "fresh-scan", verbs: { async harness(args: any) {
    if (args.operation === "close") {
      closed.push(args.sessionId);
      return { state: "success", value: { outcome: "accepted" } };
    }
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "weave", sessionId: `fresh-${++created}` } };
    assert.equal(args.sessionId, `fresh-${created}`);
    prompts.push(JSON.parse(args.prompt.split("\n").at(-1)));
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } };
  for (let i = 0; i < 3; i++) {
    await f.resources.patchStatus(await f.weave(), { nextAt: at });
    await reconcile(execution, await f.weave());
  }
  assert.equal(created, 2, "a completed scan does not create more sessions without changed evidence");
  assert.deepEqual(closed, ["obsolete-rules", "fresh-1"]);
  assert.deepEqual(prompts.map(p => [p.rootCount, p.pendingCount, p.candidates.length]), [[3, 3, 2], [3, 1, 1]]);
  assert.ok(prompts.every(p => p.total === undefined), "pending count cannot masquerade as the catalog total");
  assert.equal(new Set(prompts.flatMap(p => p.candidates.map((c: any) => c.uid))).size, 3);
  const reviewed = f.reviewed()!;
  for (const root of roots) assert.equal(reviewed[root.metadata.uid]!.version, candidateVersion(root));
});

/** @case One pending root can find and join an already reviewed parent outside its batch. */
test("Weave distinguishes a single candidate from its catalog and extends an existing tree", async t => {
  const f = fixture(t); await f.initialize();
  const a = await ensureSourceTopic(f.resources, "existing-a", "A"), b = await ensureSourceTopic(f.resources, "existing-b", "B");
  await f.group(a, b);
  const parent = f.aide.topics.resource(f.aide.topics.list().find(topic => isRootTopic({ spec: topic }))!.id)!;
  const candidate = await ensureSourceTopic(f.resources, "new-child", "Related evidence");
  const other = await ensureSourceTopic(f.resources, "other", "Independent topic");
  const at = "2000-01-01T00:00:00.000Z";
  await f.mark(Object.fromEntries([parent, other].map(topic =>
    [topic.metadata.uid, { at, version: candidateVersion(topic) }])));
  let reconcile!: (execution: any, owner: any) => Promise<unknown>;
  registerWeave({ ...f.context, controllers: { register(def: any) { reconcile = def.reconcile; } } } as unknown as PluginContext);
  const execution = { executionId: "single-candidate", verbs: { async harness(args: any) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "weave", sessionId: "fresh" } };
    const batch = JSON.parse(args.prompt.split("\n").at(-1));
    assert.equal(batch.rootCount, 3);
    assert.equal(batch.pendingCount, 1);
    assert.deepEqual(batch.candidates.map((c: any) => c.uid), [candidate.metadata.uid]);
    const roots = weaveCandidates(await f.resources.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE));
    const found = searchRootTopics(roots, "Shared subject", 0, 12);
    assert.equal(found.rootCount, 3);
    assert.equal(found.matchingRootCount, 1);
    assert.equal(found.query, "Shared subject");
    assert.deepEqual(found.items.map(c => c.uid), [parent.metadata.uid]);
    const noMatch = searchRootTopics(roots, "missing subject", 0, 12);
    assert.equal(noMatch.rootCount, 3);
    assert.equal(noMatch.matchingRootCount, 0);
    await groupTopics(f.resources, await f.weave(), { topics: [{ uid: candidate.metadata.uid, version: understandingVersion(f.refresh(candidate)) }],
      parent: { uid: parent.metadata.uid, version: understandingVersion(f.refresh(parent), notes(f.aide.topics.resources, parent.metadata.uid, "subject")) } }, 4000);
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } };
  await reconcile(execution, await f.weave());
  assert.equal(f.refresh(candidate).spec.parentRef?.uid, parent.metadata.uid);
  assert.equal(f.refresh(a).spec.parentRef?.uid, parent.metadata.uid);
  assert.equal(f.refresh(b).spec.parentRef?.uid, parent.metadata.uid);
  assert.equal(weaveCandidates(await f.resources.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE)).length, 2);
  assert.equal(f.reviewed()?.[candidate.metadata.uid], undefined, "grouped children leave the root scan");
});

test("Weave retains the old binding and coverage when session release fails", async t => {
  const f = fixture(t); await f.initialize();
  await ensureSourceTopic(f.resources, "a", "A"); await ensureSourceTopic(f.resources, "b", "B");
  const agent = { harness: "weave", sessionId: "previous-session" };
  await f.resources.patchStatus(await f.weave(), { agent });
  let reconcile!: (execution: any, owner: any) => Promise<unknown>;
  registerWeave({ ...f.context, controllers: { register(def: any) { reconcile = def.reconcile; } } } as unknown as PluginContext);
  const execution = { executionId: "release-failed", verbs: { async harness(args: any) {
    assert.equal(args.operation, "close", "do not start inference before the prior session is released");
    throw newHarnessError("harness_execution_failed", "close unavailable");
  } } };
  await assert.rejects(reconcile(execution, await f.weave()), { name: "HarnessError", message: "close unavailable" });
  assert.deepEqual((await f.weave()).status.agent, agent);
  assert.deepEqual(f.reviewed(), {});
});

/** @case Checked roots above a soft target are reconsidered after a bounded interval, without forcing unrelated grouping. */
test("Weave revisits unchanged roots above its soft target without spinning between checks", async t => {
  const f = fixture(t); await f.initialize();
  const roots = await Promise.all(["one", "two"].map(key => ensureSourceTopic(f.resources, key, key)));
  const old = "2000-01-01T00:00:00.000Z";
  await f.mark(Object.fromEntries(roots.map(topic => [topic.metadata.uid, { version: candidateVersion(topic), at: old }])));
  let reconcile!: (execution: any, owner: any) => Promise<unknown>;
  registerWeave({ ...f.context, instance: { config: { weave: { maxRoots: 1, intervalMs: 1000, reviewIntervalMs: 60_000 } } },
    controllers: { register(def: any) { reconcile = def.reconcile; } } } as unknown as PluginContext);
  const prompts: any[] = [];
  const execution = { executionId: "pressure", verbs: { async harness(args: any) {
    if (args.operation === "close") return { state: "success", value: { outcome: "accepted" } };
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "weave", sessionId: "pressure" } };
    prompts.push(JSON.parse(args.prompt.split("\n").at(-1)));
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } };
  await reconcile(execution, await f.weave());
  assert.equal(prompts.length, 1); assert.equal(prompts[0].maxRoots, 1); assert.equal(prompts[0].rootCount, 2);
  await f.resources.patchStatus(await f.weave(), { nextAt: old, lastRunAt: old });
  await reconcile(execution, await f.weave());
  assert.equal(prompts.length, 1, "unchanged pressure does not immediately repeat inference");
  const current = await f.weave();
  await f.resources.patchStatus(current, { nextAt: old, lastRunAt: old });
  await f.mark(Object.fromEntries(Object.entries(f.reviewed()).map(([uid, value]) => [uid, { ...value, at: old }])));
  await reconcile(execution, await f.weave());
  assert.equal(prompts.length, 2);
  assert.equal(f.aide.topics.list().filter(t => isRootTopic({ spec: t })).length, 2, "soft pressure does not force a grouping");
});

/** @case Reconciliation reads bounded indexed sets even when the catalog exceeds its soft target. */
test("Weave does not list the full Topic catalog before or after a review", async t => {
  const f = fixture(t); await f.initialize();
  for (let i = 0; i < 65; i++) await ensureSourceTopic(f.resources, `bounded:${i}`, String(i));
  const pages: Array<{ index?: string; count: number }> = [];
  const resources: typeof f.resources = { ...f.resources,
    async list(type, options) { assert.notEqual(type.kind, "Topic", "no full catalog lookup"); return f.resources.list(type, options); },
    async page(type, options) {
      const result = await f.resources.page(type, options);
      if (type.kind === "Topic") pages.push({ index: options.matchIndex?.name, count: result.items.length });
      return result as any;
    },
  };
  let reconcile!: (execution: any, owner: any) => Promise<unknown>;
  registerWeave({ ...f.context, resources, controllers: { register(def: any) { reconcile = def.reconcile; } } } as PluginContext);
  const execution = { executionId: "bounded", verbs: { async harness(args: any) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "weave", sessionId: "bounded" } };
    const batch = JSON.parse(args.prompt.split("\n").at(-1));
    assert.equal(batch.rootCount, 21); assert.equal(batch.rootCountExact, false);
    assert.ok(batch.candidates.length <= 12);
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } };
  await reconcile(execution, await f.weave());
  assert.deepEqual(pages, [{ index: "weaveRoot", count: 21 }, { index: "weavePending", count: 40 }]);
  assert.equal(Object.keys(f.reviewed()).length, 12);
});
