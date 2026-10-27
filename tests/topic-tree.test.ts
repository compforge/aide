import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { PluginContext, ResourceClient, ResourceListOptions, ResourceType } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { readTopicSubtree, readTopicRoot, pendingAbsorption, understandingVersion, summaryVersion } from "../plugins/personal/topic/tree.ts";
import { resourceRef, topicScope } from "../plugins/personal/input/state.ts";
import { TOPIC_TYPE, type TopicResource } from "../plugins/personal/topic/model.ts";
import { relatedWork, topicParts } from "../plugins/personal/background.ts";
import { reconcileChief } from "../plugins/personal/topic/reconcile.ts";
import { routeByRules } from "../plugins/personal/route/rules.ts";
import { InputAttention } from "../plugins/personal/input/model.ts";
import { topicTools } from "../plugins/personal/topic/tools.ts";

function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = mkdtempSync(join(tmpdir(), "aide-topic-tree-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected inference"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const current = (topic: TopicResource) => aide.topics.resource(topic.spec.id)!;
  const attach = async (child: TopicResource, parent: TopicResource) => {
    const value = current(child);
    return resources.replace(value, { ...value.spec, parentRef: resourceRef(parent) }, value.status);
  };
  return { aide, resources, current, attach };
}

/** @case Tree queries read only indexed descendants, preserve parent-first topology, and follow reparenting without stale root ownership. */
test("Topic reads follow the parent index in topological order within the selected tree", async t => {
  const f = fixture(t);
  const root = await f.aide.topics.ensure("root"), other = await f.aide.topics.ensure("other");
  const a = await f.aide.topics.ensure("a"), b = await f.aide.topics.ensure("b"), leaf = await f.aide.topics.ensure("leaf");
  await f.attach(a, root); await f.attach(b, root); await f.attach(leaf, a);
  const allowed = new Set([root, a, b, leaf].map(topic => topic.metadata.uid));
  const queried: string[] = [];
  const reader: ResourceClient = { ...f.resources, async list<S, T>(type: ResourceType, options?: ResourceListOptions) {
    assert.equal(type.kind, "Topic"); assert.equal(options?.matchIndex?.name, "parent");
    assert.ok(allowed.has(options!.matchIndex!.value), "unrelated parent was queried");
    queried.push(options!.matchIndex!.value);
    return f.resources.list<S, T>(type, options);
  } };
  const topics = await readTopicSubtree(reader, resourceRef(root));
  assert.equal(topics[0]!.metadata.uid, root.metadata.uid);
  assert.deepEqual(new Set(topics.map(topic => topic.metadata.uid)), allowed);
  for (const topic of topics.slice(1)) assert.ok(topics.indexOf(topics.find(parent => parent.metadata.uid === topic.spec.parentRef!.uid)!) < topics.indexOf(topic));
  assert.equal(queried.length, allowed.size);
  assert.equal((await readTopicRoot(reader, resourceRef(leaf)))!.metadata.uid, root.metadata.uid);
  assert.deepEqual(await readTopicSubtree(reader, { ...resourceRef(root), uid: "stale-uid" }), []);
  const reviewed = pendingAbsorption([...topics].reverse(), topics[0]!);
  assert.equal(reviewed[0]!.uid, leaf.metadata.uid, "knowledge review remains bottom-up");
  assert.deepEqual(new Set(f.aide.topics.scope(root.metadata.uid).map(topic => topic.metadata.uid)), allowed);

  await f.attach(a, other);
  assert.deepEqual(new Set((await topicScope(f.resources, resourceRef(root))).map(topic => topic.spec.id)), new Set(["root", "b"]));
  assert.deepEqual(new Set(f.aide.topics.scope(other.metadata.uid).map(topic => topic.spec.id)), new Set(["other", "a", "leaf"]));
  assert.equal((await readTopicRoot(f.resources, resourceRef(leaf)))!.metadata.uid, other.metadata.uid);
  const latestLeaf = f.current(leaf);
  await f.resources.patchStatus(f.current(a), { absorbed: { [leaf.metadata.uid]: understandingVersion(latestLeaf) } });
  await f.resources.delete(TOPIC_TYPE, latestLeaf.metadata.name, "v1", { uid: latestLeaf.metadata.uid, resourceVersion: latestLeaf.metadata.resourceVersion });
  assert.deepEqual(new Set((await readTopicSubtree(f.resources, resourceRef(other))).map(topic => topic.spec.id)), new Set(["other", "a"]));
});

/** @case Chief reconcile, context, tools and Work lookup never enumerate unrelated resources. */
test("Chief reads its Topic tree and related Work through scoped indexes", async t => {
  const f = fixture(t);
  const root = await f.aide.topics.ensure("root"), child = await f.aide.topics.ensure("child"), other = await f.aide.topics.ensure("other");
  await f.attach(child, root);
  await f.resources.replace(f.current(root), { ...root.spec, trigger: { enabled: false } }, root.status);
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const context = { resources: f.resources, logger, instance: { config: {} } } as unknown as PluginContext;
  for (const topic of [child, other]) {
    const fact = await f.aide.topics.submit(`fact-${topic.spec.id}`, { origin: "source", originId: "fixture", topicId: topic.spec.id,
      attention: InputAttention.Deferred, text: `evidence for ${topic.spec.id}` });
    await routeByRules(context, fact);
    await f.aide.work(topic.spec.id).create({ kind: "task", title: topic.spec.id, instruction: "Inspect evidence", trigger: null }, fact.metadata.name, `call-${topic.spec.id}`);
  }
  // Absorb current child understanding so this quiet read has no inference work.
  await f.resources.patchStatus(f.current(root), { absorbed: { [child.metadata.uid]: understandingVersion(f.current(child)) },
    absorbedSummaries: { [child.metadata.uid]: summaryVersion(f.current(child)) } });
  const store = f.aide.personal.store, originalList = store.resources.list.bind(store.resources);
  const allowed = new Set([root.metadata.uid, child.metadata.uid, root.spec.id, child.spec.id]);
  store.resources.list = (type, options) => {
    assert.ok(options?.matchIndex, `Unscoped ${type.kind} read`);
    assert.ok(allowed.has(options.matchIndex.value), `Unrelated ${type.kind} read`);
    return originalList(type, options);
  };
  const scoped: ResourceClient = { ...f.resources, async list<S, T>(type: ResourceType, options?: ResourceListOptions) {
    assert.ok(options?.matchIndex, `Unscoped Runner ${type.kind} read`);
    assert.ok(allowed.has(options.matchIndex.value), `Unrelated Runner ${type.kind} read`);
    return f.resources.list<S, T>(type, options);
  } };
  const current = f.current(root);
  const result = await reconcileChief({ ...context, resources: scoped }, { executionId: "quiet" } as any, current);
  assert.ok(result?.requeueAfterMs);
  assert.deepEqual(f.aide.topics.pending(root.metadata.uid).map(input => input.metadata.name), ["fact-child"]);
  assert.deepEqual(f.aide.work(root.spec.id).list().map(work => work.title), ["child"]);
  assert.deepEqual(relatedWork(store, root.spec.id).map(work => work.title), ["child"]);
  assert.ok(!JSON.stringify(topicParts(store, current, root.spec.id)).includes('"title":"other"'));
  assert.deepEqual(f.aide.topics.inputs(root.spec.id).map(input => input.metadata.name), ["fact-child"]);
  const tools = topicTools(store, () => f.current(root));
  const list = tools.find(tool => tool.name === "list_topics")!;
  const view = await list.execute("read-children", {}, undefined, undefined, {} as never);
  assert.match(JSON.stringify(view), /child/);
  const read = tools.find(tool => tool.name === "read_topic")!;
  await assert.rejects(read.execute("outside", { uid: other.metadata.uid }, undefined, undefined, {} as never), /outside this root/);
});
