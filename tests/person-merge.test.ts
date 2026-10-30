import { patchSummary } from "./summary-fixture.ts";
import { contentVersion } from "../plugins/personal/context-write.ts";
import { personContext } from "../agents/chief/person.ts";
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
import { browsePersons } from "../plugins/personal/person/browse.ts";
import { ResourceStorage } from "../src/host/resource/storage.ts";
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
  assert.deepEqual(new Set(browsePersons(ResourceStorage.open(f.home), marks, { name: target.spec.name, excludeUid: target.metadata.uid }).items.map(p => p.uid)), new Set([source.metadata.uid, namesake.metadata.uid]));
  const sender = personRef(source), inputs = new InputStore(f.home), outputs = new OutputStore(f.home);
  const input = inputs.submit("test", "historical", { origin: "channel", originId: "web", text: "历史消息", sender });
  const output = outputs.create("test", "reply", { text: "历史回复", target: webAddress("topic"), receivers: [sender], topicId: "topic",
    topic: { apiVersion: "aide.dev/v1alpha4", kind: "Topic", namespace: "v1", name: "topic", uid: "topic-uid" } });
  const merged = await f.persons.merge(version(source), version(target));
  assert.equal(merged.metadata.uid, target.metadata.uid);
  assert.equal(merged.spec.name, target.spec.name);
  assert.deepEqual(merged.spec.identities, [...target.spec.identities, ...source.spec.identities]);
  assert.equal(merged.summaryText, "保留人物认识\n\n来源人物认识");
  assert.equal(merged.status.updatedBy, "user");
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
  await f.client.create(PERSON_TYPE, { name: source.metadata.name, spec: { name: "其他人", identities: [] }, status: { ...source.status, summaryRevision: "" } });
  await assert.rejects(f.persons.read(sender.name, sender.uid), /Unknown Person/);
  const reopened = openPersonCatalog(f.home, marks, log, () => {}).persons;
  assert.equal((await reopened.observe(identity("source"))).metadata.uid, target.metadata.uid);
});

test("Merge rolls back deletion and Watch notifications if the target fails validation", async t => {
  const f = await setup(t), source = await f.create("source"), target = await f.create("target");
  const before = f.changes();
  await assert.rejects(f.persons.merge(version(source), version(target), "x".repeat(16001)), /exceeds 16000/);
  assert.deepEqual(await f.persons.read(source.metadata.name), source);
  assert.deepEqual(await f.persons.read(target.metadata.name), target);
  assert.equal(f.changes(), before);
  // A target update after service reads must also roll back the preceding deletion request.
  const racing = new Persons({ ...f.client, async commit(writes: readonly ResourceCommit[]) {
    await patchSummary(f.client, target, { summary: "并发认知" });
    return f.client.commit(writes);
  } }, marks);
  await assert.rejects(racing.merge(version(source), version(target)), /version conflict/);
  assert.deepEqual(await f.persons.read(source.metadata.name), source);
  assert.equal((await f.persons.read(target.metadata.name)).summaryText, "并发认知");
  assert.equal(f.changes(), before + 1);
});

test("Merge guards both incarnations, stale sources, self-merge; retains bounded evidence", async t => {
  const f = await setup(t), source = await f.create("source"), target = await f.create("target"), me = (await f.persons.findIdentity(LOCAL_ME))!;
  await assert.rejects(f.persons.merge(version(source), version(source)), /itself/);
  await assert.rejects(f.persons.merge({ ...version(source), uid: "old-uid" }, version(target)), /version conflict/);
  await assert.rejects(f.persons.merge(version(source), { ...version(target), uid: "old-uid" }), /version conflict/);
  const updated = await patchSummary(f.client, source, { summary: "Concurrent correction" });
  await assert.rejects(f.persons.merge(version(source), version(target)), /version conflict/);
  const merged = await f.persons.merge(version(updated), version(me), "用户确认后的认识");
  assert.equal(merged.isMe, true);
  assert.equal(merged.spec.name, me.spec.name);
  assert.equal(merged.summaryText, "用户确认后的认识");
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

/** @case Independent Me configurations confirm one human; Person merges accounts and understanding atomically and idempotently. */
test("Me configuration consolidates existing Lark and WeChat Persons into one record", async t => {
  const f = await setup(t);
  const local = (await f.persons.findIdentity(LOCAL_ME))!;
  const lark = { provider: "lark", scope: "cli_work", id: "ou_me" };
  const wechat = { provider: "wechat", scope: "personal", id: "wx_me" };
  const first = await f.persons.observe(lark, "李乾坤");
  const second = await f.persons.observe(wechat, "李乾坤");
  await f.persons.summarize(first.metadata.name, first.metadata.uid, contentVersion(first), "Lark preference");
  await f.persons.summarize(second.metadata.name, second.metadata.uid, contentVersion(second), "WeChat preference");
  const persons = openPersonCatalog(f.home, { identities: [LOCAL_ME, lark, wechat] }, log, () => {}).persons;
  assert.equal((await persons.initialize()).merged, 2);
  const me = (await persons.findIdentity(lark))!;
  assert.equal(me.metadata.uid, local.metadata.uid);
  assert.equal((await persons.findIdentity(wechat))!.metadata.uid, me.metadata.uid);
  assert.equal((await persons.list()).filter(p => p.isMe).length, 1);
  assert.deepEqual(new Set(me.spec.identities.map(i => i.provider)), new Set(["web", "lark", "wechat"]));
  assert.equal(me.summaryText.includes("Lark preference"), true);
  assert.equal(me.summaryText.includes("WeChat preference"), true);
  const context = await personContext(persons);
  assert.match(context, /Lark preference/); assert.match(context, /WeChat preference/);
  assert.deepEqual(await persons.initialize(), { merged: 0 });
  assert.equal((await persons.findIdentity(lark))!.metadata.resourceVersion, me.metadata.resourceVersion);
  // Removing or reordering configuration does not split the human or change the retained UID.
  const reordered = openPersonCatalog(f.home, { identities: [wechat, LOCAL_ME] }, log, () => {}).persons;
  await reordered.initialize();
  assert.equal((await reordered.findIdentity(wechat))!.metadata.uid, me.metadata.uid);
  assert.equal((await reordered.findIdentity(lark))!.metadata.uid, me.metadata.uid);
});

test("Fresh Me configuration creates one Person and later account configuration enriches it", async t => {
  const f = await setup(t);
  const lark = { provider: "lark", scope: "cli_work", id: "ou_me" };
  const wechat = { provider: "wechat", scope: "personal", id: "wx_me" };
  // These marks have no existing owner; the unrelated local identity is not selected implicitly.
  const persons = new Persons(f.client, { identities: [lark, wechat] });
  await persons.initialize();
  const me = (await persons.findIdentity(lark))!;
  assert.equal((await persons.findIdentity(wechat))!.metadata.uid, me.metadata.uid);
  assert.equal((await persons.list()).filter(p => p.isMe).length, 1);
  const extra = { provider: "lark", scope: "cli_other", id: "ou_other" };
  const enriched = new Persons(f.client, { identities: [extra, wechat, lark] });
  await enriched.initialize();
  assert.equal((await enriched.findIdentity(extra))!.metadata.uid, me.metadata.uid);
});

test("Me consolidation preserves all profiles when their combined understanding exceeds the budget", async t => {
  const f = await setup(t), local = (await f.persons.findIdentity(LOCAL_ME))!;
  const external = { provider: "lark", scope: "cli_work", id: "ou_me" };
  const other = await f.persons.observe(external);
  await f.persons.summarize(local.metadata.name, local.metadata.uid, contentVersion(local), "a".repeat(9000));
  await f.persons.summarize(other.metadata.name, other.metadata.uid, contentVersion(other), "b".repeat(9000));
  const persons = new Persons(f.client, { identities: [LOCAL_ME, external] });
  const before = await persons.list();
  const result = await persons.initialize();
  assert.match(result.conflict!.reason, /summary exceeds/);
  assert.deepEqual(await persons.list(), before);
  const context = await personContext(persons);
  assert.ok(context.length < 11000, "Pending consolidation still shares the context text budget");
  const merged = await persons.merge(version(await persons.read(other.metadata.name)), version(await persons.read(local.metadata.name)), "用户精简的共同认识");
  assert.deepEqual(await persons.initialize(), { merged: 0 });
  assert.equal((await persons.findIdentity(external))!.metadata.uid, merged.metadata.uid);
});

test("A conflicting Me consolidation cannot partially delete identity owners", async t => {
  const f = await setup(t), local = (await f.persons.findIdentity(LOCAL_ME))!;
  const external = { provider: "lark", scope: "cli_work", id: "ou_me" };
  const other = await f.persons.observe(external);
  const marks = { identities: [LOCAL_ME, external] };
  const racing = new Persons({ ...f.client, async commit(writes) {
    await patchSummary(f.client, local, { summary: "并发用户修正" });
    return f.client.commit(writes);
  } }, marks);
  await assert.rejects(racing.initialize(), /version conflict/);
  assert.equal((await f.persons.findIdentity(external))!.metadata.uid, other.metadata.uid);
  const persons = new Persons(f.client, marks);
  await persons.initialize();
  assert.equal((await persons.findIdentity(external))!.metadata.uid, local.metadata.uid);
  assert.equal((await persons.findIdentity(external))!.summaryText, "并发用户修正");
});
