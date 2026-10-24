import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { openPersonCatalog } from "../plugins/personal/person/catalog.ts";
import { LOCAL_ME, PERSON_TYPE, personRef, type PersonResource } from "../plugins/personal/person/model.ts";
import { Persons } from "../plugins/personal/person/service.ts";
import { mergePersonSummary } from "../plugins/personal/person/merge.ts";
import { sameNamedPersons } from "../src/web/persons/merge.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { inputPrinter } from "../plugins/personal/input/printer.ts";
import { outputPrinter } from "../plugins/personal/output/printer.ts";
import { webAddress } from "../src/channel/address.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";

const marks = { identities: [LOCAL_ME] };
const version = (p: Readonly<PersonResource>) => ({ id: p.metadata.name, uid: p.metadata.uid, version: p.metadata.resourceVersion });
const identity = (id: string) => ({ provider: "test", scope: "team", id });
const log = pino({ level: "silent" });
async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-person-merge-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let changes = 0;
  const catalog = openPersonCatalog(home, marks, log, () => changes++);
  await catalog.persons.initialize();
  return { ...catalog, home, changes: () => changes,
    async create(id: string, name = "田斐", summary = "") {
      const p = await catalog.persons.observe(identity(id), name);
      await catalog.persons.edit(p.metadata.name, p.metadata.uid, p.metadata.resourceVersion, p.spec, summary);
      return catalog.persons.read(p.metadata.name);
    },
  };
}

test("Same names only select candidates; merging appends to the chosen Person without rewriting history", async t => {
  const f = await setup(t);
  const source = await f.create("source", "田斐", "来源人物认识");
  const target = await f.create("target", "田斐", "保留人物认识");
  const namesake = await f.create("namesake");
  await f.create("different", "其他人");
  assert.deepEqual(new Set(sameNamedPersons(await f.persons.list(), target).map(p => p.metadata.uid)), new Set([source.metadata.uid, namesake.metadata.uid]));
  const sender = personRef(source), inputs = new InputStore(f.home), outputs = new OutputStore(f.home);
  const input = inputs.submit("test", "historical", { origin: "channel", originId: "web", text: "历史消息", sender });
  const output = outputs.create("test", "reply", { text: "历史回复", target: webAddress("topic"), receivers: [sender], topicId: "topic",
    topic: { apiVersion: "aide.dev/v1alpha1", kind: "Topic", namespace: "v1", name: "topic", uid: "topic-uid" } });
  const merged = await f.persons.merge(version(source), version(target));
  assert.equal(merged.metadata.uid, target.metadata.uid);
  assert.equal(merged.spec.name, target.spec.name);
  assert.deepEqual(merged.spec.identities, [...target.spec.identities, ...source.spec.identities]);
  assert.equal(merged.status.summary, "保留人物认识\n\n来源人物认识");
  assert.equal(merged.status.updatedBy, "user");
  assert.ok(merged.status.recent.at(-1)!.text.includes(source.metadata.name));
  assert.equal((await f.persons.read(namesake.metadata.name)).metadata.resourceVersion, namesake.metadata.resourceVersion);
  await assert.rejects(f.persons.read(source.metadata.name), /Unknown Person/);
  assert.equal((await f.persons.observe(identity("source"))).metadata.uid, target.metadata.uid);
  const store = new PluginResourceStore({ home: f.home, pluginInstanceId: "personal" });
  store.finalizeDeletion(PERSON_TYPE, source.metadata.name);
  assert.equal(await f.client.get(sender), undefined);
  assert.deepEqual(inputs.get("historical"), input);
  assert.deepEqual(outputs.get("reply"), output);
  assert.match(inputPrinter.describe(input), /历史消息/);
  assert.match(outputPrinter.describe(output), /历史回复/);
  // Even if a resource name is reused, an old UID must not resolve to the new person.
  await f.client.create(PERSON_TYPE, { name: source.metadata.name, spec: { name: "其他人", identities: [] }, status: source.status });
  await assert.rejects(f.persons.read(sender.name, sender.uid), /Unknown Person/);
  const reopened = openPersonCatalog(f.home, marks, log, () => {}).persons;
  assert.equal((await reopened.observe(identity("source"))).metadata.uid, target.metadata.uid);
});

test("Merge rolls back deletion and Watch notifications if the target fails validation", async t => {
  const f = await setup(t), source = await f.create("source"), target = await f.create("target");
  const before = f.changes();
  await assert.rejects(f.persons.merge(version(source), version(target), "x".repeat(16001)), /Too big/);
  assert.deepEqual(await f.persons.read(source.metadata.name), source);
  assert.deepEqual(await f.persons.read(target.metadata.name), target);
  assert.equal(f.changes(), before);
  // A target update after service reads must also roll back the preceding deletion request.
  const racing = new Persons({ ...f.client, async commit(writes: readonly ResourceCommit[]) {
    await f.client.patchStatus(target, { summary: "并发认知" });
    return f.client.commit(writes);
  } }, marks);
  await assert.rejects(racing.merge(version(source), version(target)), /version conflict/);
  assert.deepEqual(await f.persons.read(source.metadata.name), source);
  assert.equal((await f.persons.read(target.metadata.name)).status.summary, "并发认知");
  assert.equal(f.changes(), before + 1);
});

test("Merge guards both incarnations, stale sources, self-merge and Me; retains bounded evidence", async t => {
  const f = await setup(t), source = await f.create("source"), target = await f.create("target"), me = (await f.persons.me())!;
  await assert.rejects(f.persons.merge(version(source), version(source)), /itself/);
  await assert.rejects(f.persons.merge({ ...version(source), uid: "old-uid" }, version(target)), /version conflict/);
  await assert.rejects(f.persons.merge(version(source), { ...version(target), uid: "old-uid" }), /version conflict/);
  await assert.rejects(f.persons.merge(version(me), version(target)), /Me cannot be deleted/);
  const updated = await f.client.patchStatus(source, { recent: Array.from({ length: 40 }, (_, i) => ({ at: new Date(1000 * i).toISOString(), text: "e".repeat(1000) })) });
  await assert.rejects(f.persons.merge(version(source), version(target)), /version conflict/);
  const merged = await f.persons.merge(version(updated), version(me), "用户确认后的认识");
  assert.equal(merged.isMe, true);
  assert.equal(merged.spec.name, me.spec.name);
  assert.equal(merged.status.summary, "用户确认后的认识");
  assert.ok(merged.status.recent.length <= 40);
  assert.ok(merged.status.recent.reduce((n, entry) => n + entry.text.length, 0) <= 16000);
});

test("Concurrent merges have one winner; losing target never gains identities", async t => {
  const f = await setup(t), source = await f.create("source"), a = await f.create("a"), b = await f.create("b");
  const result = await Promise.allSettled([f.persons.merge(version(source), version(a)), f.persons.merge(version(source), version(b))]);
  assert.equal(result.filter(r => r.status === "fulfilled").length, 1);
  assert.equal((await f.persons.list()).filter(p => p.spec.identities.some(i => i.id === "source")).length, 1);
  assert.equal((await f.persons.list()).filter(p => [a.metadata.uid, b.metadata.uid].includes(p.metadata.uid) && p.spec.identities.length === 1).length, 1);
});

test("Connector observation resolves the transferred identity after a concurrent merge", async t => {
  const f = await setup(t), source = await f.create("source", "source"), target = await f.create("target");
  const delayedReplace: ResourceClient = { ...f.client, async replace(resource, spec, status) {
    await f.persons.merge(version(source), version(target));
    return f.client.replace(resource, spec, status);
  } };
  const observed = await new Persons(delayedReplace, marks).observe(identity("source"), "田斐");
  assert.equal(observed.metadata.uid, target.metadata.uid);
  assert.equal((await f.persons.list()).filter(p => p.spec.identities.some(i => i.id === "source")).length, 1);
});

test("Summary merge keeps differing contents, avoids exact duplication and does not truncate", () => {
  assert.equal(mergePersonSummary("", "来源"), "来源");
  assert.equal(mergePersonSummary("当前", ""), "当前");
  assert.equal(mergePersonSummary("相同", "相同"), "相同");
  assert.equal(mergePersonSummary("a".repeat(16000), "b".repeat(16000)).length, 32002);
});
