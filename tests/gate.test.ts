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
import { collectTopic } from "../plugins/personal/topic/lifecycle.ts";
import { deliver } from "../plugins/personal/route/delivery.ts";

const log = pino({ level: "silent" });

test("Gate is persistent, outside topic navigation, routing candidates, organization and collection", async t => {
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
  assert.ok(!topicCandidates(aide.personal.store).some(t => t.spec.gate));
  for (const index of ["root", "weaveRoot", "weavePending", "weaveReviewed"]) {
    assert.ok(!(await resources.page(TOPIC_TYPE, { limit: 20, matchIndex: { name: index, value: "root" } })).items.some(t => t.metadata.uid === gate.metadata.uid));
  }
  await assert.rejects(resources.replace(domain, { ...domain.spec, gate: true }, domain.status), /reserved/);
  await assert.rejects(resources.replace(gate, { ...gate.spec, gate: false }, gate.status), /reserved/);
  await assert.rejects(resources.replace(gate, { ...gate.spec, parentRef: resourceRef(domain) }, gate.status), /cannot join/);
  await assert.rejects(resources.replace(domain, { ...domain.spec, parentRef: resourceRef(gate) }, domain.status), /cannot have children/);
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
  await aide.settled(); assert.equal(chiefCalls, 1); assert.equal(gateCalls, 1);
  assert.ok(!aide.topics.inputStore.list().some(i => i.status.topic?.uid === gate.metadata.uid && i.spec.origin.startsWith("aide:")));
  await aide.close(); aide = new Aide(home, options, log);
  await aide.receive(fixtureIncoming({ channelId: "web", topicId: "gate", id: "followup", text: "继续追问" }));
  await aide.settled();
  assert.equal(gateCalls, 2); assert.deepEqual(aide.topics.resource("gate")!.status.agent, gate.status.agent);
});

test("Gate read tools discover multiple roots and enforce the active owner on every call", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-gate-reads-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No Work"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.topics.ensure("gate");
  const first = await aide.topics.ensure("first"), second = await aide.topics.ensure("second");
  let active = true;
  const tools = gateReadTools(aide.personal.store, () => { if (!active) throw new Error("Inactive owner"); });
  const call = async (name: string, args: unknown) => {
    const value = await tools.find(t => t.name === name)!.execute("test", args, undefined, undefined, {} as never);
    return JSON.parse((value.content[0] as { text: string }).text);
  };
  assert.deepEqual((await call("list_topics", {})).items.map((t: { uid: string }) => t.uid).sort(), [first.metadata.uid, second.metadata.uid].sort());
  assert.equal((await call("read_topic", { uid: second.metadata.uid })).url, "/?topic=second");
  const work = await aide.work("first").create({ kind: "routine", title: "Existing domain work", instruction: "Domain responsibility", trigger: { cron: null, timezone: "UTC", event: "check" } });
  assert.equal((await call("read_work", { id: work.id })).id, work.id);
  assert.equal((await call("list_work", { kind: "routine", q: "domain" })).items[0].id, work.id);
  await assert.rejects(aide.work("gate").requestInput(work.id, { text: "change domain" }), /Unknown work/);
  assert.ok(!tools.some(t => /^(move|upsert|prune|retire|summarize|delete|create)_/.test(t.name)));
  active = false; await assert.rejects(call("read_topic", { uid: first.metadata.uid }), /Inactive owner/);
});
