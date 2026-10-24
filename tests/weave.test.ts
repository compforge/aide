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
