import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyedSet } from "@compforge/ts-stdx/collections";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { ResourceStorage } from "../src/host/resource/storage.ts";
import { cloneResourceValue, equalResourceValue } from "../src/resource-value.ts";
import { KEYED_TYPE, KeyedDefinition, members } from "./fixtures/keyed-definitions.ts";

test("Resource sets survive storage, patch, paging, validators, indexes and restart without sharing mutable members", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-values-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new PluginResourceStore({ home, pluginInstanceId: "example" });
  let validations = 0, notifications = 0;
  store.storage.register("example", [{ ...KeyedDefinition, validator: { update(before, after, context) {
    assert(before.spec.people instanceof KeyedSet);
    assert(after.status.receivers instanceof KeyedSet);
    assert(context.get<typeof before.spec, typeof before.status>(KEYED_TYPE, before.metadata.uid)?.spec.people instanceof KeyedSet);
    assert(context.list<typeof before.spec, typeof before.status>(KEYED_TYPE)[0]?.spec.people instanceof KeyedSet);
    validations++;
  } } }]);
  store.storage.subscribeWrites((_owner, value) => { assert((value.spec as { people: unknown }).people instanceof KeyedSet); notifications++; });
  const client = createResourceClient(store);
  const source = members([{ uid: "b" }, { uid: "a", label: "first" }]);
  const resource = await client.create(KEYED_TYPE, { name: "one", spec: { people: source }, status: { receivers: members() } });
  assert(resource.spec.people instanceof KeyedSet);
  assert.throws(() => resource.spec.people.add({ uid: "c" }), TypeError);
  assert.throws(() => { [...resource.spec.people][0]!.label = "changed"; }, TypeError);
  source.clear();
  assert.equal(resource.spec.people.size, 2);
  const copy = cloneResourceValue(resource);
  copy.spec.people.delete({ uid: "a" });
  assert.equal(resource.spec.people.size, 2);
  assert(!equalResourceValue(copy, resource));
  const noChange = await client.replace(resource, { people: members([{ uid: "b" }, { uid: "a", label: "first" }, { uid: "b" }]) }, resource.status);
  assert.equal(noChange.metadata.resourceVersion, resource.metadata.resourceVersion);
  const updated = await client.patch(resource, { type: "json", value: [
    { op: "test", path: "/spec/people", value: resource.spec.people },
    { op: "replace", path: "/spec/people", value: members([{ uid: "c" }]) },
    { op: "replace", path: "/status/receivers", value: members([{ uid: "b" }]) },
  ] });
  assert.equal(updated.metadata.generation, 2);
  assert(updated.spec.people.has({ uid: "c" }));
  assert.equal((await client.page(KEYED_TYPE, { limit: 1, matchIndex: { name: "people", value: "c" } })).items.length, 1);
  assert.equal(validations, 1);
  assert.equal(notifications, 2);
  const raw = store.storage.db.prepare("SELECT data FROM resources").get()!.data as string;
  assert.deepEqual(JSON.parse(raw).object.spec.people, [{ uid: "c" }]);
  const reopened = new ResourceStorage(home);
  t.after(() => reopened.db.close());
  reopened.register("example", [KeyedDefinition]);
  const restored = reopened.read(store.key(KEYED_TYPE, "one"))!.object as typeof resource;
  assert(restored.spec.people.has({ uid: "c" }));
  assert(restored.status.receivers.has({ uid: "b" }));
});
