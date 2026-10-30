import { retryOnConflict, ResourceVersionConflict, ResourceIncarnationChanged } from "@compforge/aide-plugin";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient, type ResourceClientChange } from "../src/host/plugin/resource/client.ts";
import { serializedError, restoredError } from "../src/protocol/ipc.ts";
const TYPE = { apiVersion: "test.dev/v1", kind: "Document" };
function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "patch-"));
  const store = new PluginResourceStore({ home, pluginInstanceId: "test" });
  store.storage.register("test", [{ type: TYPE, schema: { spec: z.object({ title: z.string() }), status: z.record(z.string(), z.unknown()) } }]);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const events: ResourceClientChange[] = [];
  return { store, events, client: createResourceClient(store, e => events.push(e)) };
}
test("stale merge patches preserve independent fields, nested keys and actual Watch snapshots", async t => {
  const { client, events } = fixture(t);
  const initial = await client.create(TYPE, { name: "one", spec: { title: "A" }, status: { summary: "old", next: 1, nested: { a: 1, b: 2 }, items: [1, 2] } });
  const scheduled = await client.patchStatus(initial, { next: 2 });
  const edited = await client.patchStatus(initial, { summary: "new" });
  assert.equal(edited.status.next, 2);
  const event = events.at(-1)!;
  assert.ok(event.kind === "status-updated"); assert.deepEqual(event.oldResource, scheduled);
  const merged = await client.patch(initial, { type: "merge", value: { status: { nested: { a: null, c: 3 }, items: [3] } } });
  assert.deepEqual(merged.status.nested, { b: 2, c: 3 }); assert.deepEqual(merged.status.items, [3]);
  assert.equal(merged.metadata.generation, 1);
  const before = events.length;
  assert.equal((await client.patchStatus(initial, { next: 2 })).metadata.resourceVersion, merged.metadata.resourceVersion);
  assert.equal(events.length, before, "A no-op on the current state emits no Watch event");
  await assert.rejects(client.patchStatus(initial, { next: 4 }, { resourceVersion: initial.metadata.resourceVersion }), /version conflict/);
  await assert.rejects(client.replace(initial, initial.spec, initial.status), /version conflict/);
  const labeled = await client.patchMetadata(initial, { labels: { owner: "test" } });
  const metadataEvent = events.at(-1)!;
  assert.ok(metadataEvent.kind === "metadata-updated");
  assert.deepEqual(metadataEvent.oldResource, merged);
  assert.deepEqual(metadataEvent.resource, labeled);
});
test("JSON tests and commit writes are atomic, literal null survives, identity paths cannot change", async t => {
  const { client, store, events } = fixture(t);
  const initial = await client.create(TYPE, { name: "one", spec: { title: "A" }, status: { summary: "old" } });
  const edited = await client.patch(initial, { type: "json", value: [
    { op: "test", path: "/status/summary", value: "old" }, { op: "replace", path: "/status/summary", value: "new" },
    { op: "add", path: "/status/value", value: null }, { op: "replace", path: "/spec/title", value: "B" },
  ] });
  assert.equal(edited.metadata.generation, 2); assert.equal((edited.status as any).value, null);
  await assert.rejects(client.patch(initial, { type: "merge", value: { metadata: { labels: { invalid: 42 } } } }), /string/);
  const count = events.length;
  await assert.rejects(client.commit([
    { operation: "patchStatus", resource: initial, patch: { next: 5 } },
    { operation: "patch", resource: initial, patch: { type: "json", value: [{ op: "test", path: "/status/summary", value: "old" }] } },
  ]), /Test operation failed/);
  assert.deepEqual(store.get(TYPE, "one"), edited); assert.equal(events.length, count);
  for (const path of ["", "/metadata", "/metadata/uid", "/apiVersion"]) {
    await assert.rejects(client.patch(initial, { type: "json", value: [{ op: "replace", path, value: {} }] }), /Invalid resource patch path/);
  }
  await assert.rejects(client.patch(initial, { type: "merge", value: { metadata: { uid: "other" } } }), /immutable/);
  try { await client.patch(initial, { type: "json", value: [{ op: "test", path: "/status/summary", value: "old" }] }); }
  catch (error) { assert.equal(restoredError(serializedError(error)).name, "TEST_OPERATION_FAILED"); }
});
test("an old Resource handle cannot patch a recreated incarnation", async t => {
  const { client, store } = fixture(t);
  const old = await client.create(TYPE, { name: "one", spec: { title: "A" }, status: {} });
  await client.delete(TYPE, "one"); store.finalizeDeletion(TYPE, "one");
  const next = await client.create(TYPE, { name: "one", spec: { title: "B" }, status: {} });
  await assert.rejects(client.patchStatus(old, { value: 1 }), /incarnation changed/);
  await assert.rejects(client.replace(old, old.spec, old.status), { name: "ResourceIncarnationChanged" });
  assert.deepEqual(store.get(TYPE, "one"), next);
});


test("bounded conflict retry re-reads state, recognizes IPC names and leaves other failures to its caller", async t => {
  const { client } = fixture(t);
  const initial = await client.create(TYPE, { name: "retry", spec: { title: "A" }, status: { count: 0 } });
  await assert.rejects(client.create(TYPE, { name: "retry", spec: { title: "B" }, status: {} }),
    error => restoredError(serializedError(error)).name === "ResourceAlreadyExists");
  let attempts = 0;
  await retryOnConflict(async () => {
    const current = (await client.get<typeof initial.spec, typeof initial.status>({ ...TYPE, ...initial.metadata }))!;
    if (++attempts === 1) await client.patchStatus(current, { count: 10 });
    await client.patchStatus(current, { count: current.status.count + 1 }, { resourceVersion: current.metadata.resourceVersion });
  });
  assert.equal(attempts, 2);
  assert.equal((await client.get<typeof initial.spec, typeof initial.status>({ ...TYPE, ...initial.metadata }))!.status.count, 11);
  attempts = 0;
  const conflict = restoredError(serializedError(new ResourceVersionConflict("race")));
  await assert.rejects(retryOnConflict(async () => { attempts++; throw conflict; }), error => error === conflict);
  assert.equal(attempts, 5);
  for (const error of [new Error("version conflict in business content"), new ResourceIncarnationChanged("recreated")]) {
    attempts = 0;
    await assert.rejects(retryOnConflict(async () => { attempts++; throw error; }), actual => actual === error);
    assert.equal(attempts, 1);
  }
});
