import { seedNotes } from "./fixtures/notes.ts";
import { upsertNote } from "../plugins/personal/note/service.ts";
import { writeSummary } from "../plugins/personal/note/summary.ts";
import { webAddress } from "../src/channel/address.ts";
import { TASK_TYPE, type TaskSpec, type TaskStatus } from "../plugins/personal/task/model.ts";
import { browseGateNotes, browseGateWork } from "../plugins/personal/gate/browse.ts";
import { upsertOngoing } from "../plugins/personal/ongoing/service.ts";
import { isGateTopic } from "../plugins/personal/topic/boundary.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { httpChannel } from "../src/api/index.ts";
import { fakeOptions } from "./fake-harness.ts";
import { fixtureIncoming } from "./address-fixture.ts";
import { ensureGateTopic } from "../plugins/personal/gate/topic.ts";
import { TOPIC_TYPE } from "../plugins/personal/topic/model.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { browseTopics } from "../plugins/personal/topic/browse.ts";
import { gateReadTools } from "../plugins/personal/gate/read-tools.ts";
import { canReclaimTopic } from "../plugins/personal/topic/retention.ts";
import { topicCandidates } from "../plugins/personal/background.ts";
import { collectTopic } from "../plugins/personal/chief/session.ts";
import { deliver } from "../plugins/personal/route/delivery.ts";

const log = pino({ level: "silent" });

test("Gate is persistent, global root with isolated domain Chiefs, outside navigation and collection", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-gate-"));
  const options = fakeOptions({ async execute() { throw new Error("Unexpected Work"); } }, home);
  let aide = new Aide(home, options, log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const gates = await Promise.all(Array.from({ length: 8 }, () => ensureGateTopic(resources)));
  const gate = gates[0]!;
  assert.ok(gates.every(g => g.metadata.uid === gate.metadata.uid));
  const domain = await aide.topics.ensure("domain");
  assert.deepEqual(browseTopics(aide.topics, { selectedId: "gate" }).items.map(t => t.id), ["domain"]);
  assert.equal(browseTopics(aide.topics, { selectedId: "gate" }).path.length, 0);
  assert.ok(!topicCandidates(aide.personal.store).some(t => isGateTopic(t)));
  for (const index of ["root", "weaveRoot", "weavePending", "weaveReviewed"]) {
    assert.ok(!(await resources.page(TOPIC_TYPE, { limit: 20, matchIndex: { name: index, value: "root" } })).items.some(t => t.metadata.uid === gate.metadata.uid));
  }
  const { parentRef: _parent, ...detached } = domain.spec;
  await assert.rejects(resources.replace(domain, detached, domain.status), /reserved/);
  assert.ok(isGateTopic(gate));
  assert.ok(!isGateTopic(domain));
  assert.ok(!("gate" in gate.spec));
  await assert.rejects(resources.replace(gate, { ...gate.spec, parentRef: resourceRef(domain) }, gate.status), /reserved/);
  assert.equal(domain.spec.parentRef?.uid, gate.metadata.uid);
  assert.deepEqual(aide.topics.scope(gate.metadata.uid).map(t => t.metadata.uid), [gate.metadata.uid]);
  assert.deepEqual(aide.topics.scope(domain.metadata.uid).map(t => t.metadata.uid), [domain.metadata.uid]);
  await assert.rejects(resources.replace(gate, { ...gate.spec, review: { enabled: true } }, gate.status), /maintenance/);
  await assert.rejects(resources.delete(TOPIC_TYPE, gate.metadata.name), /cannot be deleted/);
  assert.equal(canReclaimTopic(gate, {} as never), false);
  await collectTopic({} as never, { ...gate, status: { ...gate.status, agent: { harness: "gate", sessionId: "persist" }, lastInputAt: "2000-01-01T00:00:00Z" } }, {
    verbs: { harness() { throw new Error("Must not release Gate session on idle"); } },
  } as never);
  const input = await aide.topics.submit("external", { origin: "source", originId: "test", text: "ordinary observation" });
  await assert.rejects(deliver({ resources, logger: { info() {} } }, input, [gate.metadata], "model chose gate", undefined, true), /no longer exists/);
  await aide.close(); aide = new Aide(home, options, log);
  assert.equal((await ensureGateTopic(aide.runtime.plugins.resourceClient("personal"))).metadata.uid, gate.metadata.uid);
});

test("Gate Web requests bypass semantic Route, stream replies, deduplicate and resume the Gate session", { timeout: 30_000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-gate-web-"));
  let gateCalls = 0, chiefCalls = 0;
  const options = fakeOptions({ async gate() { gateCalls++; return "Gate answer"; }, async chief() { chiefCalls++; return "Domain answer"; },
    async route() { throw new Error("Explicit requests must not invoke semantic routing"); }, async execute() { throw new Error("No Work expected"); } }, home);
  let aide = new Aide(home, options, log);
  const server = httpChannel(aide, log);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await aide.close(); rmSync(home, { recursive: true, force: true }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  for (const asset of ["/gate", "/gate.js", "/gate.css"]) assert.equal((await fetch(base + asset)).status, 200);
  const state = await (await fetch(base + "/gate/state")).json() as { topicId: string; uid: string };
  assert.equal(state.topicId, "gate");
  const gateHtml = await (await fetch(base + "/gate")).text();
  assert.deepEqual([...gateHtml.matchAll(/role="tab"[^>]*>([^<]+)/g)].map(match => match[1]), ["对话", "Note", "Work"]);
  const pending = await fetch(base + "/gate/work?page=3");
  assert.equal(pending.status, 200);
  assert.deepEqual(await pending.json(), { total: 0, pageSize: 20, pages: 1, page: 1, items: [] });
  assert.equal((await fetch(base + "/gate/work?kind=note")).status, 400);
  assert.equal((await fetch(base + "/gate/notes?nature=summary")).status, 400);
  assert.equal((await fetch(base + "/gate/notes?nature=unclassified")).status, 200);
  const send = (value: unknown) => fetch(base + "/gate/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await send({ id: "bad", text: "hello", topicId: "domain" })).status, 400);
  const message = { id: "hello", text: "跨 Topic 问题" };
  assert.equal((await send(message)).status, 200);
  await aide.settled();
  const gate = aide.topics.resource("gate")!;
  assert.equal(gateCalls, 1); assert.equal(chiefCalls, 0);
  assert.equal(gate.status.agent?.harness, "gate"); assert.ok(gate.status.agent?.sessionId);
  assert.equal(aide.topics.inputs("gate").length, 1);
  assert.ok(aide.topics.inputs("gate")[0]!.status.assess?.completedAt);
  assert.deepEqual(aide.outputs().map(o => o.target), [{ kind: "channel", channelId: "web", endpoint: "gate" }]);
  assert.equal((await send(message)).status, 200); await aide.settled(); assert.equal(gateCalls, 1);
  await aide.receive(fixtureIncoming({ channelId: "web", topicId: "domain", id: "domain", text: "领域问题" }));
  await aide.settled(); assert.equal(chiefCalls, 0); assert.equal(gateCalls, 2);
  assert.ok(!aide.topics.inputStore.list().some(i => i.status.topic?.uid === gate.metadata.uid && i.spec.origin.startsWith("aide:")));
  await aide.close(); aide = new Aide(home, { ...options, agentSession: "new" }, log);
  await aide.start(); await aide.settled();
  assert.deepEqual(aide.topics.resource("gate")!.status.agent, gate.status.agent, "an idle new-mode boot leaves Gate bound");
  await aide.close(); aide = new Aide(home, options, log);
  await aide.receive(fixtureIncoming({ channelId: "web", topicId: "gate", id: "followup", text: "继续追问" }));
  await aide.settled();
  assert.equal(gateCalls, 3); assert.deepEqual(aide.topics.resource("gate")!.status.agent, gate.status.agent);

  await aide.close(); aide = new Aide(home, { ...options, agentSession: "new" }, log);
  const sendGate = async (id: string) => {
    await aide.receive(fixtureIncoming({ channelId: "web", topicId: "gate", id, text: id }));
    await aide.settled();
    return aide.topics.resource("gate")!.status.agent?.sessionId;
  };
  const replacement = await sendGate("after-upgrade");
  assert.ok(replacement); assert.notEqual(replacement, gate.status.agent?.sessionId);
  assert.equal(await sendGate("again"), replacement);
  assert.equal(gateCalls, 5);
});

test("Gate read tools discover multiple roots and enforce the active owner on every call", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-gate-reads-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No Work"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.topics.ensure("gate");
  const first = await aide.topics.ensure("first"), second = await aide.topics.ensure("second");
  let active = true;
  const tools = gateReadTools(aide.personal.store, () => { if (!active) throw new Error("Inactive owner"); });
  const execute = (name: string, args: unknown) => tools.find(tool => tool.name === name)!.execute("test", args, undefined, undefined, {} as never);
  const call = async (name: string, args: unknown) => {
    const value = await execute(name, args);
    return JSON.parse((value.content[0] as { text: string }).text);
  };
  assert.deepEqual((await call("list_topics", {})).items.map((t: { uid: string }) => t.uid).sort(), [first.metadata.uid, second.metadata.uid].sort());
  assert.equal((await call("read_topic", { uid: second.metadata.uid })).url, "/?topic=second");
  const work = await aide.work("first").create({ kind: "routine", title: "Existing domain work", instruction: "Domain responsibility", trigger: { cron: null, timezone: "UTC", event: "check" } });
  assert.equal((await call("read_work", { id: work.id })).id, work.id);
  const resources = aide.personal.store.client;
  const writer = await resources.patchStatus(second, { execution: { id: "seed", startedAt: new Date().toISOString() } });
  const { upsertOngoing } = await import("../plugins/personal/ongoing/service.ts");
  const original = await upsertNote(resources, writer, { text: "Verify rc.7" }, "target");
  const snapshot = await execute("read_note", { noteId: original.noteId.slice(0, 13) });
  const revised = await upsertNote(resources, writer, { noteId: original.noteId, version: original.version, text: "Verify rc.8" }, "revised");
  assert.notEqual(original.version, revised.version);
  assert.deepEqual(snapshot.details, { customType: "aide.note", details: { kind: "note", uid: original.uid, version: original.version } });
  const noteSnapshot = JSON.parse((snapshot.content[0] as { text: string }).text);
  assert.equal(noteSnapshot.text, "Verify rc.7");
  assert.equal(noteSnapshot.url, `/gate?note=${original.noteId}`);
  assert.equal((await call("read_note", { noteId: original.noteId })).version, revised.version);
  const matter = await upsertOngoing(resources, writer, { title: "Awaiting the approval" }, "approval");
  assert.equal((await call("list_work", { kind: "ongoing", topicUid: second.metadata.uid })).items[0].id, matter.id);
  assert.equal(JSON.parse((await call("read_work", { id: matter.id })).text).title, matter.title);
  assert.deepEqual((await execute("read_work", { id: matter.id })).details,
    { customType: "aide.ongoing", details: { kind: "ongoing", uid: matter.uid, version: matter.version } });
  assert.ok(!tools.some(tool => tool.name === "upsert_work"));
  assert.equal((await call("list_work", { kind: "routine", q: "domain" })).items[0].id, work.id);
  await assert.rejects(aide.work("gate").create({ kind: "routine", title: "Forbidden Gate work", instruction: "Must delegate", trigger: { cron: null, timezone: "UTC", event: "check" } }), /cannot own new Work/);
  await assert.rejects(aide.work("gate").appendInput(work.id, { text: "change domain" }), /Unknown work/);
  assert.ok(!tools.some(t => /^(move|upsert|prune|retire|summarize|delete|create)_/.test(t.name)));
  active = false; await assert.rejects(call("read_topic", { uid: first.metadata.uid }), /Inactive owner/);
});

test("Gate pages open Ongoings across domains by check time and clamps a disappearing last page", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-gate-ongoings-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected work"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const server = httpChannel(aide, log);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const resources = aide.personal.store.client;
  async function actor(id: string) {
    const root = await aide.topics.ensure(id);
    await resources.patchStatus(root, { execution: { id, startedAt: new Date().toISOString() } });
    return aide.topics.resource(id)!;
  }
  const a = await actor("first"), b = await actor("second");
  const plan = { question: null, checkAt: "2099-02-01T00:00:00.000Z" };
  const late = await upsertOngoing(resources, a, { ...plan, title: "Later" }, "a");
  const early = await upsertOngoing(resources, b, { ...plan, title: "Earlier", checkAt: "2099-01-01T00:00:00.000Z" }, "b");
  const unscheduled = await upsertOngoing(resources, a, { ...plan, title: "Unscheduled" }, "c");
  const open = await upsertOngoing(resources, a, { ongoingId: unscheduled.id, version: unscheduled.version, checkAt: null, question: null }, "clear");
  const read = (page: number) => browseGateWork(aide.topics.resources.storage, { kind: "ongoing", pageSize: 2, page });
  assert.deepEqual(read(1).items.map(i => [i.uid, i.topicId]), [[early.uid, "second"], [late.uid, "first"]]);
  assert.deepEqual(read(2).items.map(i => i.uid), [open.uid]);
  const previousList = await fetch(base + "/gate/ongoings?pageSize=2&page=2");
  assert.deepEqual((await previousList.json() as { items: unknown[] }).items, [{
    uid: open.uid, id: open.id, title: "Unscheduled", question: null, progress: null, checkAt: null,
    topicId: "first", topicName: read(2).items[0]!.topicName,
  }]);
  const supplement = (id: string, text: string, key = "supplement") =>
    fetch(base + "/gate/ongoings/supplement", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ id, text }),
    });
  assert.equal((await supplement(open.id, "  ")).status, 400);
  assert.equal((await supplement("missing", "An update")).status, 404);
  await resources.patchStatus(aide.topics.resource("first")!, { execution: null, lastInputAt: new Date(0).toISOString() });
  const text = "审批已通过，可以关闭。";
  const submitted = await Promise.all([supplement(open.id, text), supplement(open.id, text)]);
  assert.deepEqual(submitted.map(reply => reply.status), [200, 200]);
  const [first, duplicate] = await Promise.all(submitted.map(reply => reply.json())) as [{ inputId: string }, { inputId: string }];
  assert.deepEqual(first, duplicate);
  const input = aide.topics.inputStore.get(first.inputId)!;
  assert.ok(Date.parse(aide.topics.resource("first")!.status.lastInputAt!) > 0);
  assert.equal(input.spec.text, text);
  assert.equal(input.spec.origin, "channel");
  assert.equal(input.spec.originId, "web");
  assert.equal(input.status.topic?.uid, a.metadata.uid);
  assert.equal(input.status.assess, undefined);
  assert.equal(input.status.handle?.[open.uid]?.resource.uid, open.uid);
  assert.equal(read(2).items[0]?.uid, open.uid);
  await aide.settled();
  const followup = aide.topics.inputStore.list().find(i => i.spec.origin === "aide:followup" && i.spec.observation?.ongoingUid === open.uid);
  assert.deepEqual(followup?.spec.observation?.inputIds, [first.inputId]);
  assert.equal(followup?.status.topic?.uid, a.metadata.uid);
  const current = await aide.work("first").readItem(open.id);
  assert.ok(current.kind === "ongoing");
  await upsertOngoing(resources, await actor("first"), { ongoingId: open.id, version: current.version, outcome: "Done", checkAt: null, question: null }, "close");
  assert.equal((await supplement(open.id, text)).status, 200, "a lost receipt can be retried after Chief closes the matter");
  assert.equal((await supplement(open.id, "Another update", "new-key")).status, 409);
  const refreshed = read(2);
  assert.equal(refreshed.page, 1);
  assert.equal(refreshed.total, 2);
  const closed = browseGateWork(aide.topics.resources.storage, { state: "ended" });
  assert.deepEqual(closed.items.map(item => [item.status, item.id, item.kind === "ongoing" && item.outcome]), [["closed", open.id, "Done"]]);
});


test("Gate filters Notes independently of their summary owner and pages all Work kinds together", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-gate-lists-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected execution"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const client = aide.personal.store.client, storage = aide.topics.resources.storage;
  const first = await aide.topics.ensure("one"), second = await aide.topics.ensure("two");
  const person = await aide.persons.observe({ provider: "test", scope: "gate", id: "one" }, "Alex");
  const address = aide.addresses.observe(webAddress("home"));
  const chief = await client.patchStatus(first, { execution: { id: "draft", startedAt: new Date().toISOString() } });
  await upsertNote(client, chief, { text: "Draft" }, "draft");
  await seedNotes(client, chief, [{ id: "how", text: "How", nature: "procedural" }]);
  await seedNotes(client, second, [{ id: "fact", text: "Fact", nature: "semantic", updatedAt: "2020-01-01T00:00:00.000Z" }]);
  await writeSummary(client, aide.topics.resource("one")!, { text: "Topic summary", nature: "semantic" });
  await writeSummary(client, person, { text: "Person summary", nature: "semantic" });
  await writeSummary(client, address, { text: "Address summary", nature: "procedural" });
  assert.deepEqual(browseGateNotes(storage, { nature: "unclassified" }).items.map(n => n.title), ["Draft"]);
  const semantic = browseGateNotes(storage, { nature: "semantic", page: 3, pageSize: 1 });
  assert.equal(semantic.total, 3);
  assert.deepEqual(semantic.items.map(n => [n.title, n.topicId]), [["Fact", "two"]]);
  const notes = browseGateNotes(storage, {});
  assert.equal(notes.total, 6);
  assert.deepEqual(notes.items.filter(n => n.summaryKind).map(n => n.summaryKind).sort(), ["Address", "Person", "Topic"]);
  assert.equal(notes.items.find(n => n.subject.uid === person.metadata.uid)?.ownerName, "Alex");

  const task = await aide.work("one").create({ kind: "task", title: "Investigate", instruction: "Inspect", trigger: null });
  await aide.work("two").create({ kind: "routine", title: "Report", instruction: "Report", trigger: { cron: null, timezone: "UTC", event: "check" } });
  const actor = await client.patchStatus(aide.topics.resource("two")!, { execution: { id: "seed", startedAt: new Date().toISOString() } });
  await upsertOngoing(client, actor, { title: "Confirm" }, "check");
  const page = browseGateWork(storage, { pageSize: 2 });
  assert.equal(page.total, 3);
  const rest = browseGateWork(storage, { page: 2, pageSize: 2 });
  assert.deepEqual([...page.items, ...rest.items].map(w => [w.kind, w.topicId]).sort(), [["ongoing", "two"], ["routine", "two"], ["task", "one"]]);
  const resource = aide.topics.resources.get<TaskSpec, TaskStatus>(TASK_TYPE, task.id);
  await client.patchStatus(resource, { completion: { at: new Date().toISOString(), text: "Done", observedGeneration: resource.metadata.generation } });
  assert.equal(browseGateWork(storage, { kind: "task" }).total, 0);
  assert.deepEqual(browseGateWork(storage, { state: "ended" }).items.map(w => w.status), ["done"]);
  assert.equal(browseGateWork(storage, { state: "all" }).total, 3);
});
