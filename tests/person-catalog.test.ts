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
import { PERSON_TYPE, PERSON_SESSION, LOCAL_ME, personRef } from "../plugins/personal/person/model.ts";
import { Persons } from "../plugins/personal/person/service.ts";
import { messageRelation } from "../plugins/personal/source/message/relation.ts";
import { emptyConnectors } from "../src/connector-client.ts";
import { personMessages } from "../plugins/personal/person/messages.ts";
import { InputStore } from "../src/host/input/store.ts";

const log = pino({ level: "silent" });
async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-person-catalog-"));
  const configFile = join(home, "config.yaml");
  writeFileSync(configFile, JSON.stringify({ connectors: { lark: { appId: "cli_execution", userId: "ou_operator",
    me: [{ appId: "cli_bot", openId: "ou_human" }, { appId: "cli_execution", openId: "ou_me" }] } } }));
  const options = { ...fakeOptions({ async chief() { return "ok"; }, async execute() { throw new Error("No work"); } }, home), config: loadConfig(configFile) };
  let aide = new Aide(home, options, log); await aide.start();
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, get aide() { return aide; }, async restart() { await aide.close(); aide = new Aide(home, options, log); await aide.start(); } };
}

test("Person catalog resolves identities across sessions, preserves profiles across restart and rejects identity collisions", async (t) => {
  const f = await setup(t);
  const me = (await f.aide.persons.me())!;
  assert.equal(me.spec.identities.some((i) => i.id === "ou_operator"), false);
  const identity = { provider: "lark", scope: "cli_bot", id: "ou_zhang" };
  const [first, again] = await Promise.all([f.aide.persons.observe(identity, "张三"), f.aide.persons.observe(identity, "张三")]);
  assert.equal(first.metadata.uid, again.metadata.uid);
  const sameName = await f.aide.persons.observe({ ...identity, scope: "cli_other" }, "张三");
  assert.notEqual(first.metadata.uid, sameName.metadata.uid);
  const scope = f.aide.session("another-conversation"); await scope.start();
  const across = new Persons(scope.plugins.resourceClient("personal"), { identities: [LOCAL_ME] });
  assert.equal((await across.read(first.metadata.name)).metadata.uid, first.metadata.uid);
  const profiled = await across.profile(first.metadata.name, first.metadata.uid, first.metadata.resourceVersion, "2026-10-21：关注可靠性；来自明确表达。");
  await assert.rejects(f.aide.persons.edit(sameName.metadata.name, sameName.metadata.uid, sameName.metadata.resourceVersion,
    { ...sameName.spec, identities: [identity] }), /already belongs/);
  await assert.rejects(f.aide.persons.edit(me.metadata.name, me.metadata.uid, me.metadata.resourceVersion,
    { ...me.spec, identities: [] }), /cannot be removed/);
  await f.restart();
  assert.equal((await f.aide.persons.read(first.metadata.name)).metadata.uid, first.metadata.uid);
  assert.deepEqual((await f.aide.persons.read(first.metadata.name)).spec.profile, profiled.spec.profile);
  assert.equal(f.aide.sessions().some((s) => s.id === PERSON_SESSION), false);
  assert.equal(f.aide.conversationIds().includes(PERSON_SESSION), false);
});

test("profile_person guards versions and preserves user corrections while Input retention remains independent", async (t) => {
  const f = await setup(t);
  const me = (await f.aide.persons.me())!;
  const edited = await f.aide.persons.edit(me.metadata.name, me.metadata.uid, me.metadata.resourceVersion,
    { ...me.spec, profile: { understanding: "", corrections: "不要再把别人的观点当成我的偏好。" } });
  const tool = personTools(f.aide.persons).find((tool) => tool.name === "profile_person")!;
  await assert.rejects(tool.execute("stale", { id: "me", uid: me.metadata.uid, version: me.metadata.resourceVersion, understanding: "stale" }, undefined, undefined, {} as never), /version conflict/);
  await tool.execute("fresh", { id: "me", uid: edited.metadata.uid, version: edited.metadata.resourceVersion, understanding: "明确表达：关注机器人的可靠性。" }, undefined, undefined, {} as never);
  const current = (await f.aide.persons.me())!;
  assert.deepEqual(current.spec.identities, me.spec.identities);
  assert.equal(current.spec.profile.corrections, edited.spec.profile.corrections);
  const inputs = new InputStore(f.home);
  inputs.storage.configure({ kinds: { "aide.dev/Input": { maxCount: 1 } } } as Parameters<typeof inputs.storage.configure>[0]);
  const input = inputs.submit("test", "old", { origin: "source", originId: "test", text: "evidence", sender: personRef(current) });
  inputs.update(input, { routing: { phase: "done", reason: "test" } });
  inputs.submit("test", "new", { origin: "source", originId: "test", text: "no sender" });
  assert.equal(inputs.get("old"), undefined);
  assert.equal(inputs.get("new")!.spec.sender, undefined);
  assert.equal((await f.aide.persons.me())!.spec.profile.understanding, current.spec.profile.understanding);
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
  assert.equal(other.isMe, false); assert.equal(other.spec.profile.understanding, "");
});

test("Web exposes two navigation pages and edits the same Person with conflict detection", async (t) => {
  const f = await setup(t); const server = httpChannel(f.aide, log);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const path of ["/", "/people"]) {
    const html = await (await fetch(base + path)).text();
    assert.match(html, /Conversations/); assert.match(html, /Persons/);
  }
  const me = (await f.aide.persons.me())!;
  assert.equal((await (await fetch(base + "/persons")).json() as unknown[]).length, 1);
  const body = { id: me.metadata.name, uid: me.metadata.uid, version: me.metadata.resourceVersion,
    spec: { ...me.spec, name: "张三", profile: { understanding: "可靠性", corrections: "偏好简洁中文" } } };
  const save = () => fetch(base + "/persons/edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await save()).status, 200);
  assert.equal((await f.aide.persons.me())!.spec.profile.corrections, "偏好简洁中文");
  assert.equal((await save()).status, 409);
  assert.equal((await fetch(base + "/persons?id=missing")).status, 404);
  const resource = await f.aide.catalog.client.get({ ...PERSON_TYPE, namespace: "v1", name: "me" });
  assert.equal(resource!.metadata.uid, me.metadata.uid);
});
