import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceDefinition, ResourceValidationContext, ResourceCommit, ResourceType, ResourceListOptions } from "@compforge/aide-plugin";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import definitions from "../plugins/personal/definitions.ts";
import { PersonDefinition } from "../plugins/personal/person/definition.ts";
import { PERSON_TYPE, identityKey, type Person, type PersonIdentity, type PersonStatus } from "../plugins/personal/person/model.ts";
import { TOPIC_TYPE, type TopicResource } from "../plugins/personal/topic/model.ts";
import { INPUT_TYPE } from "../plugins/personal/input/model.ts";
import { TASK_TYPE } from "../plugins/personal/task/model.ts";
import { ROUTINE_TYPE } from "../plugins/personal/routine/model.ts";
import { ensureDefaultTopic } from "../plugins/personal/topic/default.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { understandingVersion } from "../plugins/personal/topic/tree.ts";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-validation-scope-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new PluginResourceStore({ home, pluginInstanceId: "personal" });
  const queries: { kind: string; index?: string; uid?: string; count: number }[] = [];
  const observe = (context: ResourceValidationContext): ResourceValidationContext => ({
    get<S, T>(type: ResourceType, uid: string) {
      const result = context.get<S, T>(type, uid);
      queries.push({ kind: type.kind, uid, count: Number(!!result) });
      return result;
    },
    list<S, T>(type: ResourceType, options?: Pick<ResourceListOptions, "namespace" | "matchIndex">) {
      assert.ok(options?.matchIndex, `${type.kind} validation must not scan the entire kind`);
      const result = context.list<S, T>(type, options);
      queries.push({ kind: type.kind, index: options.matchIndex.name, count: result.length });
      return result;
    },
  });
  const watched = <S, T>(definition: ResourceDefinition<S, T>): ResourceDefinition<S, T> => {
    const validator = definition.validator;
    return { ...definition, validator: {
      create: (r, c) => validator?.create?.(r, observe(c)),
      update: (p, r, c) => validator?.update?.(p, r, observe(c)),
      delete: (r, c) => validator?.delete?.(r, observe(c)),
    } };
  };
  const declared: ResourceDefinition[] = [...definitions, PersonDefinition];
  store.storage.register("personal", declared.map(watched));
  const resources = createResourceClient(store);
  const topic = (name: string, parent?: TopicResource) => resources.create<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE,
    { name, spec: { id: name, ...(parent ? { parentRef: resourceRef(parent) } : {}) }, status: { summary: "", receipts: [] } });
  const person = (name: string, identities: PersonIdentity[]) => resources.create<Person, PersonStatus>(PERSON_TYPE,
    { name, spec: { name, identities }, status: { summary: "", updatedAt: new Date().toISOString(), updatedBy: "user" } });
  return { store, resources, queries, topic, person };
}

/** @case Reserved Default identity stays unique across namespaces without scanning on routine updates. */
test("Default creation uses its singleton index and updates perform no dependency queries", async t => {
  const f = fixture(t);
  await f.topic("unrelated");
  const fallback = await ensureDefaultTopic(f.resources);
  assert.deepEqual(f.queries, [{ kind: "Topic", index: "default", count: 0 }]);
  f.queries.length = 0;
  const updated = await f.resources.patchStatus(fallback, { summary: "A fallback observation" });
  await f.resources.replace(updated, { ...updated.spec, name: "Fallback" }, updated.status);
  assert.deepEqual(f.queries, []);
  await assert.rejects(f.resources.create(TOPIC_TYPE, { name: fallback.metadata.name, namespace: "v1/project/other",
    spec: fallback.spec, status: fallback.status }), /Default Topic already exists/);
  assert.deepEqual(f.queries, [{ kind: "Topic", index: "default", count: 1 }]);
});

/** @case Profile writes skip identity queries; additions and transactional transfers still enforce exact ownership. */
test("Person validation checks new identities only and rolls back transferred indexes", async t => {
  const f = fixture(t), identity = { provider: "web", scope: "test", id: "account" };
  const owner = await f.person("owner", [identity]);
  let target = await f.person("target", [{ ...identity, scope: "other" }]);
  f.queries.length = 0;
  target = await f.resources.patchStatus(target, { summary: "New understanding" });
  target = await f.resources.replace(target, { ...target.spec, name: "Renamed" }, target.status);
  assert.deepEqual(f.queries, []);
  await assert.rejects(f.resources.replace(target, { ...target.spec, identities: [...target.spec.identities, identity] }, target.status), /already belongs/);
  assert.deepEqual(f.queries, [{ kind: "Person", index: "identity", count: 1 }]);
  const transfer: ResourceCommit[] = [
    { operation: "delete", resource: owner },
    { operation: "replace", resource: target, spec: { ...target.spec, identities: [...target.spec.identities, identity] }, status: target.status },
  ];
  await assert.rejects(f.resources.commit([...transfer, { operation: "create", type: { ...PERSON_TYPE, kind: "Missing" }, name: "reject", spec: {} }]), /Unknown resource/);
  const lookup = () => f.resources.list(PERSON_TYPE, { matchIndex: { name: "identity", value: identityKey(identity) } });
  assert.deepEqual((await lookup()).map(p => p.metadata.uid), [owner.metadata.uid]);
  assert.equal((await f.resources.get(resourceRef(owner)))!.metadata.deletionTimestamp, undefined);
  await f.resources.commit(transfer);
  assert.deepEqual((await lookup()).map(p => p.metadata.uid), [target.metadata.uid]);
  await assert.rejects(f.person("duplicate", [identity]), /already belongs/);
  target = (await f.resources.get<Person, PersonStatus>(resourceRef(target)))!;
  f.queries.length = 0;
  target = await f.resources.replace(target, { ...target.spec, identities: [...target.spec.identities].reverse() }, target.status);
  await f.resources.replace(target, { ...target.spec, identities: [] }, target.status);
  assert.deepEqual(f.queries, [], "reordering and releasing identities need no ownership queries");
});

/** @case Delete reads current dependencies only, excluding unrelated work and retained completed Input history. */
test("Topic deletion reads indexed dependents and the parent UID, not retained history", async t => {
  const f = fixture(t), parent = await f.topic("parent"), leaf = await f.topic("leaf", parent), other = await f.topic("other");
  await f.resources.patchStatus(parent, { absorbed: { [leaf.metadata.uid]: understandingVersion(leaf) } });
  for (let i = 0; i < 30; i++) await f.resources.create(INPUT_TYPE, { name: `history-${i}`,
    spec: { origin: "source", originId: "fixture", text: "Retained evidence" },
    status: { topic: resourceRef(i % 2 ? other : leaf), assess: i % 2 ? {} : { completedAt: new Date().toISOString() } } });
  for (const type of [TASK_TYPE, ROUTINE_TYPE]) await f.resources.create(type, { name: type.kind,
    spec: { title: "Unrelated work", instruction: "Observe", ...(type.kind === "Task" ? { initialInputId: "history-1" } : { trigger: { cron: null, timezone: "UTC", event: "changed" } }) },
    status: { topic: resourceRef(other) } });
  f.queries.length = 0;
  await f.resources.delete(TOPIC_TYPE, leaf.metadata.name);
  assert.ok((await f.resources.get(resourceRef(leaf)))!.metadata.deletionTimestamp);
  const listed = f.queries.filter(q => q.index);
  assert.deepEqual(listed.map(q => [q.kind, q.index]), [["Topic", "parent"], ["Input", "assessPending"], ["Task", "topic"], ["Routine", "topic"], ["Note", "subject"]]);
  assert.ok(listed.every(q => q.count === 0));
  assert.ok(f.queries.some(q => q.uid === parent.metadata.uid));
});

/** @case A dependent written earlier in the same transaction prevents deletion and rolls back the entire write set. */
for (const kind of ["Topic", "Input", "Task", "Routine"]) test(`Topic deletion sees a newly created ${kind} in its transaction`, async t => {
  const f = fixture(t), parent = await f.topic("parent");
  const types = { Topic: TOPIC_TYPE, Input: INPUT_TYPE, Task: TASK_TYPE, Routine: ROUTINE_TYPE };
  const type = types[kind as keyof typeof types];
  const spec = kind === "Topic" ? { id: "dependent", parentRef: resourceRef(parent) }
    : kind === "Input" ? { origin: "source", originId: "fixture", text: "Pending" }
    : { title: "Pending work", instruction: "Observe", ...(kind === "Task" ? { initialInputId: "fact" } : { trigger: { cron: null, timezone: "UTC", event: "changed" } }) };
  const status = kind === "Topic" ? {} : { topic: resourceRef(parent), ...(kind === "Input" ? { assess: {} } : {}) };
  await assert.rejects(f.resources.commit([
    { operation: "create", type, name: "dependent", spec, status },
    { operation: "delete", resource: parent },
  ]), /still has children|pending Input|still owns Work/);
  assert.equal((await f.resources.get(resourceRef(parent)))!.metadata.deletionTimestamp, undefined);
  assert.equal(await f.resources.get({ ...type, namespace: "v1", name: "dependent" }), undefined);
});
