import { InputAttention } from "../plugins/personal/input/model.ts";
import { registerWeave } from "../plugins/personal/weave/reconcile.ts";
import { candidatePage, weaveCandidates, candidateFingerprint } from "../plugins/personal/weave/candidates.ts";
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
import { planGroup, applyGroup } from "../plugins/personal/weave/service.ts";
import { TOPIC_TYPE, type TopicResource } from "../plugins/personal/topic/model.ts";
import { ensureSourceTopic, topicPath, understandingVersion } from "../plugins/personal/topic/tree.ts";
import { reconcileChief } from "../plugins/personal/topic/reconcile.ts";
import { collectTopic } from "../plugins/personal/topic/lifecycle.ts";
import { summarizeTopic } from "../plugins/personal/topic/state.ts";
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
  const group = async (...topics: TopicResource[]) => planGroup(resources, await weave(), {
    topics: topics.map(t => ({ uid: t.metadata.uid, version: understandingVersion(refresh(t)) })), name: "Shared subject", summary: "Preserved child findings",
  }, 4000);
  const input = async (id: string, key: string) => {
    const fact = await aide.topics.submit(id, { origin: "source", originId: "fixture", topicKey: key, text: id });
    await routeByRules(context, fact);
    return aide.topics.inputStore.get(id)!;
  };
  return { aide, resources, context, weave, initialize, refresh, group, input };
}

test("Weave quiesces roots, preserves source binding and completed receipts, and moves pending inputs and work", async t => {
  const f = fixture(t); await f.initialize();
  const first = await f.input("first", "source:a");
  const a = f.aide.topics.byKey("source:a")!, b = await ensureSourceTopic(f.resources, "source:b", "B");
  const done = new Date().toISOString();
  await f.resources.patchStatus(first, { assess: { [a.metadata.uid]: { ...first.status.assess![a.metadata.uid]!, completedAt: done } } });
  const work = await f.aide.work(a.spec.id).create({ kind: "routine", title: "Continue", instruction: "Follow up", trigger: { cron: null, timezone: "UTC", event: "changed" } });
  await f.resources.patchStatus(f.refresh(a), { agent: { harness: "chief", sessionId: "native-a" }, execution: { id: "old-chief", startedAt: done } });
  await f.group(a, b);
  assert.equal(await applyGroup(f.resources, await f.weave()), "waiting");
  await f.input("during-freeze", "source:a");
  await f.resources.patchStatus(f.refresh(a), { execution: null });
  assert.equal(await applyGroup(f.resources, await f.weave()), "applied");
  const parent = f.aide.topics.resource(f.aide.topics.list().find(t => !t.parentRef && !t.topicKey)!.id)!;
  assert.equal(f.refresh(a).spec.parentRef!.uid, parent.metadata.uid);
  assert.equal(f.refresh(b).spec.parentRef!.uid, parent.metadata.uid);
  assert.equal(parent.spec.topicKey, undefined);
  assert.equal(parent.spec.address, undefined);
  const closed: string[] = [];
  await reconcileChief(f.context, { verbs: { async harness(input: { operation: string; sessionId: string }) {
    assert.equal(input.operation, "close"); closed.push(input.sessionId);
    return { state: "success", value: { outcome: "accepted" } };
  } } } as unknown as import("@compforge/aide-plugin").ReconcileContext, f.refresh(a));
  assert.deepEqual(closed, ["native-a"]);
  assert.equal(f.refresh(a).status.agent, undefined);

  assert.equal(f.aide.works().find(w => w.id === work.id)!.topicId, parent.spec.id);
  assert.deepEqual(f.aide.topics.inputStore.get("first")!.status.assess, { [a.metadata.uid]: { ...first.status.assess![a.metadata.uid]!, completedAt: done } });
  const pending = f.aide.topics.inputStore.get("during-freeze")!;
  assert.deepEqual(pending.status.route!.result!.topics, [resourceRef(a)]);
  assert.deepEqual(Object.keys(pending.status.assess!), [parent.metadata.uid]);
  assert.equal(f.aide.topics.inputs(a.spec.id).length, 2);
  assert.equal(f.aide.topics.inputs(parent.spec.id).length, 2);
  const later = await f.input("later", "source:a");
  assert.deepEqual(Object.keys(later.status.assess!), [parent.metadata.uid]);
  assert.deepEqual(later.status.route!.result!.topics, [resourceRef(a)]);
  assert.deepEqual(topicCandidates(f.aide.personal.store).map(c => c.uid), [parent.metadata.uid]);
});

test("Changed understanding and uncertain effects release a Weave plan without replay or partial parenting", async t => {
  const f = fixture(t); await f.initialize();
  const fact = await f.input("uncertain", "a"), a = f.aide.topics.byKey("a")!, b = await ensureSourceTopic(f.resources, "b", "B");
  await f.resources.patchStatus(f.refresh(a), { execution: { id: "finishing", startedAt: new Date().toISOString() } });
  await f.group(a, b);
  await f.resources.patchStatus(f.refresh(a), { summary: "A late, material finding", execution: null });
  assert.equal(await applyGroup(f.resources, await f.weave()), "stale");
  assert.equal(f.refresh(a).spec.parentRef, undefined);
  assert.equal(f.refresh(a).status.weaveLock, null);
  await f.resources.patchStatus(fact, { assess: { [a.metadata.uid]: { ...fact.status.assess![a.metadata.uid]!, executionId: "unknown", lastError: "Inspect effects first" } } });
  await f.group(a, b);
  assert.equal(await applyGroup(f.resources, await f.weave()), "stale");
  assert.equal(f.aide.topics.inputStore.get("uncertain")!.status.assess![a.metadata.uid]!.executionId, "unknown");
});

test("Topic expiry checks child absorption, releases source key, and never revives an old routed Input", async t => {
  const f = fixture(t); await f.initialize();
  const fact = await f.input("old", "a"), a = f.aide.topics.byKey("a")!, b = await ensureSourceTopic(f.resources, "b", "B");
  await f.resources.patchStatus(fact, { assess: { [a.metadata.uid]: { ...fact.status.assess![a.metadata.uid]!, completedAt: new Date().toISOString() } } });
  await f.group(a, b); await applyGroup(f.resources, await f.weave());
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
  await f.group(a, b); await applyGroup(f.resources, await f.weave());
  const parent = f.aide.topics.list().find(t => !t.parentRef)!;
  const c = await ensureSourceTopic(f.resources, "c", "C");
  await f.group(f.aide.topics.resource(parent.id)!, c); await applyGroup(f.resources, await f.weave());
  const input = await f.input("fresh", "a");
  const all = await f.resources.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE);
  const path = topicPath(all, f.refresh(a));
  assert.equal(path.length, 3);
  assert.equal(new Set(path.map(t => t.status.lastInputAt)).size, 1);
  assert.deepEqual(Object.keys(input.status.assess!), [path[2]!.metadata.uid]);
  const cyclic = f.refresh(path[2]!);
  await assert.rejects(f.resources.replace(cyclic, { ...cyclic.spec, parentRef: resourceRef(a) }, cyclic.status), /cycle/);
});

test("Weave drains more than 100 writes in frozen batches before exposing a new root", async t => {
  const f = fixture(t); await f.initialize();
  for (let n = 0; n < 120; n++) await f.input(`burst-${n}`, "burst");
  const a = f.aide.topics.byKey("burst")!, b = await ensureSourceTopic(f.resources, "peer", "Peer");
  await f.group(a, b);
  assert.equal(await applyGroup(f.resources, await f.weave()), "waiting");
  const persisted = await f.weave();
  assert.equal(persisted.status.plan!.moving, true);
  assert.equal(f.refresh(a).spec.parentRef, undefined);
  assert.deepEqual(topicCandidates(f.aide.personal.store), [], "Both old roots and staged parent are frozen");
  await f.input("while-moving", "burst");
  assert.equal(await applyGroup(f.resources, await f.weave()), "applied");
  const root = f.aide.topics.list().find(t => !t.parentRef)!;
  const uid = f.aide.topics.resource(root.id)!.metadata.uid;
  assert.equal(f.aide.topics.pending(uid).length, 121);
  assert.equal(f.aide.topics.pending(a.metadata.uid).length, 0);
  assert.equal(f.aide.topics.inputs(root.id).length, 121);
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
  assert.equal((await f.weave()).status.scanned, 0);
  fail = false;
  for (let i = 0; i < 3; i++) {
    await f.resources.patchStatus(await f.weave(), { nextAt: "2000-01-01T00:00:00.000Z" });
    await reconcile(execution, await f.weave());
    assert.equal((await f.weave()).status.scanned, seen.size);
  }
  assert.equal(seen.size, 24);
  await f.resources.patchStatus(f.refresh(roots[0]!), { summary: "changed during scan" });
  await f.resources.patchStatus(await f.weave(), { nextAt: "2000-01-01T00:00:00.000Z" });
  await reconcile(execution, await f.weave());
  assert.ok((await f.weave()).status.scanned! < 24, "changed directory starts a fresh scan");
});

test("A quiet changed child wakes root synthesis without Input and can then expire", async t => {
  const f = fixture(t); await f.initialize();
  const a = await ensureSourceTopic(f.resources, "absorb:a", "A"), b = await ensureSourceTopic(f.resources, "absorb:b", "B");
  await f.group(a, b); await applyGroup(f.resources, await f.weave());
  const root = f.aide.topics.list().find(t => !t.parentRef)!;
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
      assert.equal(fact.status.assess![root.metadata.uid]!.executionId, "batch");
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
  await f.group(a, b); await applyGroup(f.resources, await f.weave());
  const root = f.aide.topics.list().find(t => !t.parentRef)!;
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
  const fingerprint = candidateFingerprint([a, b]);
  await f.resources.patchStatus(a, { recent: [note] });
  assert.equal(candidateFingerprint([f.refresh(a), b]), fingerprint, "Note-only changes do not restart the stable-topic scan");
  await f.group(f.refresh(a), b); await applyGroup(f.resources, await f.weave());
  const parent = f.aide.topics.resource(f.aide.topics.list().find(topic => !topic.parentRef)!.id)!;
  assert.deepEqual(parent.status.recent, [note]);
  assert.equal(parent.status.summary, "Preserved child findings");
  assert.ok(parent.status.absorbedSummaries?.[a.metadata.uid]);
});
