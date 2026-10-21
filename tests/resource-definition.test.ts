import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { openPersonCatalog } from "../plugins/personal/person/catalog.ts";
import { PERSON_TYPE, LOCAL_ME, type Person, type PersonStatus } from "../plugins/personal/person/model.ts";

function home(t: { after(fn: () => void): void }) {
  const path = mkdtempSync(join(tmpdir(), "aide-definition-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const TYPE = { apiVersion: "tests.aide.dev/v1", kind: "Document" };
const document: ResourceDefinition = {
  type: TYPE, scope: "shared", schema: {
    spec: z.object({ text: z.string().min(1), label: z.string().default("document") }).strict(),
    status: z.object({ count: z.number().int().nonnegative().default(0) }).strict(),
  },
};

test("Definitions admit canonical data, reject unknown types and enforce shared/session scope", async (t) => {
  const dir = home(t);
  const store = new PluginResourceStore({ home: dir, pluginInstanceId: "example" });
  store.storage.register("example", [document]);
  const client = createResourceClient(store);
  const resource = await client.create(TYPE, { name: "one", spec: { text: "hello" } });
  assert.deepEqual(resource.spec, { text: "hello", label: "document" });
  assert.deepEqual(resource.status, { count: 0 });
  assert.equal(resource.metadata.sessionId, undefined);
  await assert.rejects(client.create({ ...TYPE, kind: "Unknown" }, { name: "one", spec: {} }), /Unknown resource definition/);
  const sessionStore = new PluginResourceStore({ session: { id: "session", dir: join(dir, "sessions", "session") }, pluginInstanceId: "example" });
  assert.throws(() => sessionStore.get(TYPE, "one"), /Wrong resource scope/);
  await assert.rejects(client.patchStatus(resource, { count: -1 }), /Too small/);
  await assert.rejects(client.replace(resource, { text: "" }, { count: 0 }), /Too small/);
  assert.equal(store.get(TYPE, "one").metadata.resourceVersion, "1");
});

/** @case A batch cannot bypass Person identity constraints or publish any partial write/notification. */
test("Person commit validates preceding writes and rolls back data plus notifications on collision", async (t) => {
  const dir = home(t);
  let changes = 0;
  const { client, persons } = openPersonCatalog(dir, { identities: [LOCAL_ME] }, pino({ level: "silent" }), () => changes++);
  await persons.initialize();
  changes = 0;
  const identity = { provider: "test", scope: "team", id: "alice" };
  const status = { updatedAt: new Date().toISOString(), updatedBy: "user" as const };
  await assert.rejects(client.commit([
    { operation: "create", type: PERSON_TYPE, name: "one", spec: { name: "Alice", identities: [identity] }, status },
    { operation: "create", type: PERSON_TYPE, name: "two", spec: { name: "Alias", identities: [identity] }, status },
  ]), /already belongs/);
  assert.equal((await persons.list()).length, 1);
  assert.equal(changes, 0);
  const [created] = await client.commit([{ operation: "create", type: PERSON_TYPE, name: "one", spec: { name: "Alice", identities: [identity] }, status }]);
  assert.equal(changes, 1);
  assert.equal(created!.metadata.sessionId, undefined);
  const me = (await persons.me())!;
  await assert.rejects(client.commit([{ operation: "replace", resource: me, spec: { ...me.spec, identities: [] }, status }]), /cannot be removed/);
  await assert.rejects(client.patchStatus(me, { updatedBy: "unknown" } as unknown as PersonStatus));
  await assert.rejects(client.delete(PERSON_TYPE, "one"), /deletion is not supported/);
  assert.equal((await persons.read("one")).metadata.deletionTimestamp, undefined);
});

test("Concurrent client admissions cannot bind the same external identity twice", async (t) => {
  const { client } = openPersonCatalog(home(t), { identities: [LOCAL_ME] }, pino({ level: "silent" }), () => {});
  const spec: Person = { name: "Alice", identities: [{ provider: "test", scope: "team", id: "alice" }], profile: { understanding: "", corrections: "" } };
  const status: PersonStatus = { updatedAt: new Date().toISOString(), updatedBy: "user" };
  const results = await Promise.allSettled(["one", "two"].map((name) => client.create(PERSON_TYPE, { name, spec, status })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await client.list(PERSON_TYPE)).length, 1);
});

test("Duplicate definition sets fail before adding any declaration", (t) => {
  const store = new PluginResourceStore({ home: home(t), pluginInstanceId: "example" });
  assert.throws(() => store.storage.register("example", [document, document]), /already registered/);
  assert.throws(() => store.storage.definition("example", TYPE), /Unknown resource definition/);
  store.storage.register("example", [document]);
  store.storage.register("example", [document]);
  assert.throws(() => store.storage.register("example", [{ ...document }]), /already registered/);
});

/** @case Repeated Source observations compare canonical spec, including defaults supplied by the schema. */
test("Source ensure is stable after schema defaults and validates explicit Session selection", async (t) => {
  const store = new PluginResourceStore({ home: home(t), pluginInstanceId: "example" });
  store.storage.register("example", [document]);
  assert.equal(store.ensure({ type: TYPE, name: "one", spec: { text: "hello" } }).created, true);
  assert.equal(store.ensure({ type: TYPE, name: "one", spec: { text: "hello" } }).created, false);
  const client = createResourceClient(store);
  await assert.rejects(client.create(TYPE, { name: "two", sessionId: "session", spec: { text: "hello" } }), /Session/);
  await assert.rejects(client.list(TYPE, { sessionId: "session" }), /Session/);
});

/** @case Failed retention computation must preserve the old reference graph and committed resource. */
test("Retention failures roll back writes and keep dependency references protected", async (t) => {
  const store = new PluginResourceStore({ home: home(t), pluginInstanceId: "example" });
  const definition: ResourceDefinition = { ...document, retention: {
    releasedAt: () => undefined,
    references: (resource) => {
      if ((resource.spec as { text: string }).text === "broken") throw new Error("cannot resolve references");
      return ["dependency"];
    },
  } };
  store.storage.register("example", [definition]);
  let failures = 0;
  store.storage.onRetentionError = () => failures++;
  const client = createResourceClient(store);
  const resource = await client.create(TYPE, { name: "one", spec: { text: "valid" } });
  const refs = () => store.storage.db.prepare("SELECT source,target FROM resource_refs ORDER BY source,target").all();
  const before = refs();
  await assert.rejects(client.replace(resource, { ...resource.spec, text: "broken" }, resource.status), /Resource retention failed/);
  assert.equal(failures, 1);
  assert.deepEqual(refs(), before);
  assert.deepEqual(await client.get({ ...TYPE, namespace: "v1", name: "one" }), resource);
});

test("Deleting a resource tree is atomic when a descendant validator rejects", async (t) => {
  const store = new PluginResourceStore({ home: home(t), pluginInstanceId: "example" });
  store.storage.register("example", [{ ...document, validator: { delete(r) {
    if (r.metadata.name === "child") throw new Error("child is protected");
  } } }]);
  const client = createResourceClient(store);
  const parent = await client.create(TYPE, { name: "parent", spec: { text: "parent" } });
  const child = await client.create(TYPE, { name: "child", spec: { text: "child" }, owner: {
    ...TYPE, name: parent.metadata.name, namespace: parent.metadata.namespace, uid: parent.metadata.uid,
  } });
  await assert.rejects(client.delete(TYPE, "parent"), /child is protected/);
  assert.deepEqual(await client.get({ ...TYPE, namespace: "v1", name: "parent" }), parent);
  assert.deepEqual(await client.get({ ...TYPE, namespace: "v1", name: "child" }), child);
});
