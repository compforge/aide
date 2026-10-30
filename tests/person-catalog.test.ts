import { seedNotes } from "./fixtures/notes.ts";
import { contentVersion } from "../plugins/personal/context-write.ts";
import { readNotes } from "../plugins/personal/note/query.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { httpChannel } from "../src/api/index.ts";
import { fakeOptions } from "./fake-harness.ts";
import { personTools } from "../agents/chief/person-tools.ts";
import { PERSON_TYPE, LOCAL_ME, personRef } from "../plugins/personal/person/model.ts";
import { Persons } from "../plugins/personal/person/service.ts";
import { messageRelation } from "../plugins/personal/source/message/relation.ts";
import { emptyConnectors } from "../src/connector-client.ts";
import { personMessages } from "../plugins/personal/person/messages.ts";
import { InputStore } from "../plugins/personal/input/store.ts";

const log = pino({ level: "silent" });
async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-person-catalog-"));
  const configFile = join(home, "config.yaml");
  writeFileSync(configFile, JSON.stringify({ connectors: {lark: {kind:"messages",version:"v1",config:{ appId: "cli_execution", userId: "ou_operator",
    me: [{ appId: "cli_bot", openId: "ou_human" }, { appId: "cli_execution", openId: "ou_me" }] }}} }));
  const options = { ...fakeOptions({ async chief() { return "ok"; }, async execute() { throw new Error("No work"); } }, home), config: loadConfig(configFile) };
  let aide = new Aide(home, options, log); await aide.start();
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, get aide() { return aide; }, async restart() { await aide.close(); aide = new Aide(home, options, log); await aide.start(); } };
}

test("Person catalog resolves identities across sessions, preserves profiles across restart and rejects identity collisions", async (t) => {
  const f = await setup(t);
  const me = (await f.aide.persons.findIdentity(LOCAL_ME))!;
  assert.equal(me.spec.identities.some((i) => i.id === "ou_operator"), false);
  const identity = { provider: "lark", scope: "cli_bot", id: "ou_zhang" };
  const [first, again] = await Promise.all([f.aide.persons.observe(identity, "张三"), f.aide.persons.observe(identity, "张三")]);
  assert.equal(first.metadata.uid, again.metadata.uid);
  const sameName = await f.aide.persons.observe({ ...identity, scope: "cli_other" }, "张三");
  assert.notEqual(first.metadata.uid, sameName.metadata.uid);
  const scope = f.aide.personal; await scope.start();
  const across = new Persons(scope.plugins.resourceClient("personal"), { identities: [LOCAL_ME] });
  assert.equal((await across.read(first.metadata.name)).metadata.uid, first.metadata.uid);
  const summarized = await across.summarize(first.metadata.name, first.metadata.uid, contentVersion(first), "2026-10-21：关注可靠性；来自明确表达。");
  await assert.rejects(f.aide.persons.edit(sameName.metadata.name, sameName.metadata.uid, sameName.metadata.resourceVersion,
    { ...sameName.spec, identities: [identity] }), /already belongs/);
  await assert.rejects(f.aide.persons.edit(me.metadata.name, me.metadata.uid, me.metadata.resourceVersion,
    { ...me.spec, identities: [] }), /cannot be removed/);
  await f.restart();
  assert.equal((await f.aide.persons.read(first.metadata.name)).metadata.uid, first.metadata.uid);
  assert.deepEqual((await f.aide.persons.read(first.metadata.name)).status.summary, summarized.status.summary);
  assert.equal("sessionId" in (await f.aide.persons.read(first.metadata.name)).metadata, false);
  assert.equal(f.aide.topicIds().includes("personal:persons"), false);
});

test("summarize_person guards shared summary versions while Input retention remains independent", async (t) => {
  const f = await setup(t);
  const me = (await f.aide.persons.findIdentity(LOCAL_ME))!;
  const edited = await f.aide.persons.edit(me.metadata.name, me.metadata.uid, me.metadata.resourceVersion,
    me.spec, "不要再把别人的观点当成我的偏好。");
  const tool = personTools(f.aide.persons).find((tool) => tool.name === "summarize_person")!;
  await assert.rejects(tool.execute("stale", { id: me.metadata.name, uid: me.metadata.uid, version: contentVersion(me), summary: "stale" }, undefined, undefined, {} as never), /version conflict/);
  await tool.execute("fresh", { id: me.metadata.name, uid: edited.metadata.uid, version: contentVersion(edited), summary: edited.status.summary + "明确表达：关注机器人的可靠性。" }, undefined, undefined, {} as never);
  const current = (await f.aide.persons.findIdentity(LOCAL_ME))!;
  assert.deepEqual(current.spec.identities, me.spec.identities);
  assert.ok(current.status.summary.startsWith(edited.status.summary));
  const inputs = new InputStore(f.home);
  inputs.storage.configure({ kinds: { "aide.dev/Input": { maxCount: 1 } } } as Parameters<typeof inputs.storage.configure>[0]);
  const input = inputs.submit("test", "old", { origin: "source", originId: "test", text: "evidence", sender: personRef(current) });
  inputs.update(input, { route: { completedAt: new Date().toISOString(), result: { topics: [], reason: "test" } } });
  inputs.submit("test", "new", { origin: "source", originId: "test", text: "no sender" });
  assert.equal(inputs.get("old"), undefined);
  assert.equal(inputs.get("new")!.spec.sender, undefined);
  assert.equal((await f.aide.persons.findIdentity(LOCAL_ME))!.status.summary, current.status.summary);
});

test("Execution identities do not identify Me; connector reads contribute people without attributing their views", async (t) => {
  const f = await setup(t);
  const message = { id: "one", chatId: "chat", sender: { type: "user", id: "ou_other", name: "李四" }, mentions: ["ou_operator"], content: "hello", createdAt: new Date().toISOString(), deleted: false };
  const watch = { accountId: "cli_execution", userId: "ou_operator", personIds: ["ou_me"] };
  assert.equal(messageRelation(watch, message, true), undefined);
  assert.equal(messageRelation(watch, { ...message, mentions: ["ou_me"] }, false), "received");
  assert.equal(messageRelation(watch, { ...message, sender: { type: "user", id: "ou_me", name: "我" } }, true), "sent");
  const messages = personMessages({ ...emptyConnectors.messages, async search() { return { messages: [message], hasMore: false, observedThrough: message.createdAt }; } }, f.aide.persons, "cli_execution");
  await messages.search({ start: message.createdAt, end: message.createdAt });
  const other = (await f.aide.persons.list()).find((p) => p.spec.name === "李四")!;
  assert.equal(other.isMe, false); assert.equal(other.status.summary, "");
});

test("Web exposes two navigation pages and edits the same Person with conflict detection", async (t) => {
  const f = await setup(t); const server = httpChannel(f.aide, log);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const path of ["/", "/people"]) {
    const html = await (await fetch(base + path)).text();
    assert.match(html, /Topics/); assert.match(html, /Persons/);
  }
  const me = (await f.aide.persons.findIdentity(LOCAL_ME))!;
  assert.equal((await (await fetch(base + "/persons")).json() as { pinned: unknown[] }).pinned.length, 1);
  const body = { id: me.metadata.name, uid: me.metadata.uid, version: me.metadata.resourceVersion,
    spec: { ...me.spec, name: "张三" }, summary: "偏好简洁中文" };
  const save = () => fetch(base + "/persons/edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await save()).status, 200);
  assert.equal((await f.aide.persons.findIdentity(LOCAL_ME))!.status.summary, "偏好简洁中文");
  assert.equal((await save()).status, 409);
  const edit = async (summary?: string) => {
    const current = (await f.aide.persons.findIdentity(LOCAL_ME))!;
    return fetch(base + "/persons/edit", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: current.metadata.name, uid: current.metadata.uid, version: current.metadata.resourceVersion,
        spec: { ...current.spec, name: "张三（同事）" }, summary }) });
  };
  assert.equal((await edit()).status, 200);
  assert.equal((await f.aide.persons.findIdentity(LOCAL_ME))!.status.summary, "偏好简洁中文", "Identity-only edits preserve the summary");
  assert.equal((await edit("x".repeat(16001))).status, 400);
  assert.equal((await f.aide.persons.findIdentity(LOCAL_ME))!.status.summary, "偏好简洁中文");
  assert.equal((await edit("")).status, 200);
  assert.equal((await f.aide.persons.findIdentity(LOCAL_ME))!.status.summary, "", "An explicit empty summary clears it");
  assert.equal((await fetch(base + "/persons?id=missing")).status, 404);
  const resource = await f.aide.catalog.client.get({ ...PERSON_TYPE, namespace: "v1", name: me.metadata.name });
  assert.equal(resource!.metadata.uid, me.metadata.uid);
});

test("Person context is bounded and survives identity enrichment, user correction and restart", async t => {
  const f = await setup(t);
  const identity = { provider: "lark", scope: "cli_bot", id: "ou_context" };
  let current = await f.aide.persons.observe(identity);
  current = await f.aide.persons.summarize(current.metadata.name, current.metadata.uid, contentVersion(current), "Stable understanding");
  await seedNotes(f.aide.runtime.plugins.resourceClient("personal"), current, Array.from({ length: 55 }, (_, n) => ({ id: `observation-${n}`, text: `Observation ${n}: ${"e".repeat(2000)}` })));
  const recent = await readNotes(f.aide.runtime.plugins.resourceClient("personal"), current.metadata.uid, "people");
  assert.ok(recent.length <= 40);
  assert.ok(recent.reduce((sum, item) => sum + item.text.length, 0) <= 16000);
  const summary = current.status.summary;
  current = await f.aide.persons.observe(identity, "张三");
  assert.equal(current.status.summary, summary);
  assert.deepEqual(await readNotes(f.aide.runtime.plugins.resourceClient("personal"), current.metadata.uid, "people"), recent);
  current = await f.aide.persons.edit(current.metadata.name, current.metadata.uid, current.metadata.resourceVersion,
    current.spec, "以用户明确表述为准");
  assert.equal(current.status.summary, "以用户明确表述为准");
  assert.equal(current.status.updatedBy, "user");
  assert.deepEqual(await readNotes(f.aide.runtime.plugins.resourceClient("personal"), current.metadata.uid, "people"), recent, "User corrections preserve recent Notes");
  const correctedRecent = await readNotes(f.aide.runtime.plugins.resourceClient("personal"), current.metadata.uid, "people");
  current = await f.aide.persons.edit(current.metadata.name, current.metadata.uid, current.metadata.resourceVersion,
    { ...current.spec, name: "张三（同事）" });
  assert.equal(current.status.summary, "以用户明确表述为准");
  assert.deepEqual(await readNotes(f.aide.runtime.plugins.resourceClient("personal"), current.metadata.uid, "people"), correctedRecent);
  await f.restart();
  const restored = await f.aide.persons.read(current.metadata.name);
  assert.equal(restored.status.summary, "以用户明确表述为准");
  assert.deepEqual(restored.recent, correctedRecent);
  assert.deepEqual(restored.spec, current.spec);
});

test("Web merge validates reviewed versions, finalizes the source and tolerates missing historical persons", async t => {
  const f = await setup(t), server = httpChannel(f.aide, log);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const source = await f.aide.persons.observe({ provider: "test", scope: "one", id: "source" }, "田斐");
  const target = await f.aide.persons.observe({ provider: "test", scope: "two", id: "target" }, "田斐");
  const version = (p: typeof source) => ({ id: p.metadata.name, uid: p.metadata.uid, version: p.metadata.resourceVersion });
  // Let ordinary initial reconciles finish before taking the review snapshots.
  await f.aide.settled();
  const currentSource = await f.aide.persons.read(source.metadata.name), currentTarget = await f.aide.persons.read(target.metadata.name);
  const body = { source: version(currentSource), target: version(currentTarget), summary: "已核对，是同一个人。" };
  const merge = (value: unknown) => fetch(base + "/persons/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await merge({ ...body, source: { ...body.source, uid: "stale" } })).status, 409);
  assert.equal((await merge({ ...body, source: body.target })).status, 400);
  assert.equal((await merge({ ...body, summary: "x".repeat(16001) })).status, 400);
  assert.equal((await merge(body)).status, 200);
  await f.aide.settled();
  assert.equal(await f.aide.catalog.client.get(personRef(source)), undefined, "Standard lifecycle physically removes the merged Person");
  assert.equal((await fetch(base + "/persons?id=" + source.metadata.name)).status, 404);
  assert.equal((await merge(body)).status, 409, "A repeat cannot append the same data again");
  assert.equal((await f.aide.persons.read(target.metadata.name)).status.summary, body.summary);
  assert.equal((await f.aide.persons.observe(source.spec.identities[0]!)).metadata.uid, target.metadata.uid);
  const read = personTools(f.aide.persons).find(tool => tool.name === "read_person")!;
  const missing = await read.execute("deleted", { id: source.metadata.name, uid: source.metadata.uid }, undefined, undefined, {} as never);
  assert.match(JSON.stringify(missing), /No Person matched/);
  const wrongId = await read.execute("uid-as-id", { id: target.metadata.uid }, undefined, undefined, {} as never);
  assert.match(JSON.stringify(wrongId), /does not establish deletion/);
  const matched = await read.execute("exact-reference", { id: target.metadata.name, uid: target.metadata.uid }, undefined, undefined, {} as never);
  assert.ok(JSON.stringify(matched).includes(target.metadata.uid), "The same living person remains readable through the exact reference");
  const html = await (await fetch(base + "/people")).text();
  assert.match(html, /同名人物/); assert.match(html, /姓名相同不代表同一个人/); assert.match(html, /确认是同一人并合并/);
  assert.equal((await fetch(base + "/persons.js")).status, 200);
  await f.restart();
  assert.equal(await f.aide.catalog.client.get(personRef(source)), undefined);
  assert.equal((await f.aide.persons.observe(source.spec.identities[0]!)).metadata.uid, target.metadata.uid);
});

/** @case Person records paginate past the recent budget, isolate people by UID and reject stale cursors. */
test("Web pages full related Notes newest first without persisting Person recent", async t => {
  const f = await setup(t), server = httpChannel(f.aide, log);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const person = await f.aide.persons.observe({ provider: "test", scope: "notes", id: "one" }, "One");
  const other = await f.aide.persons.observe({ provider: "test", scope: "notes", id: "two" }, "Two");
  const client = f.aide.runtime.plugins.resourceClient("personal");
  const entries = Array.from({ length: 45 }, (_, i) => ({ id: `record-${i}`, text: `Record ${i}: ${"完整内容".repeat(200)}`,
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));
  await seedNotes(client, person, entries);
  await seedNotes(client, other, [{ id: "unrelated", text: "Other person's record" }]);
  const query = new URLSearchParams({ id: person.metadata.name, uid: person.metadata.uid });
  const read = (cursor?: string) => fetch(base + '/persons/notes?' + new URLSearchParams({ ...Object.fromEntries(query), ...(cursor ? { continue: cursor } : {}) }));
  const first = await (await read()).json() as Awaited<ReturnType<Persons["notes"]>>;
  assert.equal(first.items.length, 20);
  const second = await (await read(first.continue)).json() as typeof first;
  const third = await (await read(second.continue)).json() as typeof first;
  assert.deepEqual([second.items.length, third.items.length], [20, 5]);
  assert.equal(third.continue, "");
  assert.deepEqual([...first.items, ...second.items, ...third.items].map(n => n.text), entries.toReversed().map(n => n.text));
  assert.equal("recent" in (await f.aide.persons.read(person.metadata.name, person.metadata.uid)).status, false);
  assert.equal((await fetch(base + '/persons/notes?' + new URLSearchParams({ id: person.metadata.name, uid: 'old-incarnation' }))).status, 404);
  assert.equal((await fetch(base + '/persons/notes?' + new URLSearchParams({ id: other.metadata.name, uid: other.metadata.uid, continue: first.continue! }))).status, 400);
  await seedNotes(client, person, [{ id: 'new', text: 'A new record' }]);
  assert.equal((await read(first.continue)).status, 410);
  assert.equal((await read()).status, 200);
});
