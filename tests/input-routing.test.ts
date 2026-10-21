import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { CONVERSATION_TYPE, type ConversationSpec, type ConversationStatus } from "../plugins/personal/conversation/model.ts";
import { reconcileInput } from "../plugins/personal/input.ts";
import { appendConversationInput } from "../plugins/personal/conversation/input.ts";
import { digest } from "../plugins/personal/chief-model.ts";
import { INPUT_TYPE } from "@compforge/aide-plugin";
const log = pino({ level: "silent" });

test("Default receives every Input and deterministic matches append once without calling a routing model", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-input-routing-"));
  const calls: string[] = [];
  const aide = new Aide(root, fakeOptions({ async chief(prompt) {
    assert.doesNotMatch(prompt, /Candidates:/); calls.push(prompt); return "观察已处理";
  }, async execute() { throw new Error("No delegated work expected"); } }, root), log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive({ channelId: "web", id: "a", sessionId: "group-a", text: "a-private-interest" });
  await aide.receive({ channelId: "web", id: "b", sessionId: "group-b", text: "b-private-interest" });
  await aide.receive({ channelId: "web", id: "c", sessionId: "group-c", text: "unrelated service" });
  await aide.settled();
  await aide.setDefaultConversation("group-a", true);
  const source = aide.session("source:events"); await source.start();
  await source.conversations.submit("shared", { origin: "source", originId: "personal.environments", sessionId: "group-b", text: "service changed" });
  await aide.settled();
  for (const id of ["group-a", "group-b"]) {
    const c = aide.findConversation(id)!.conversations;
    assert.equal(c.get(id)!.inputIds.filter((i) => i === "shared").length, 1);
    assert.equal(c.input("shared", id)!.status.phase, "done");
  }
  assert.equal(aide.findConversation("group-c")!.conversations.input("shared"), undefined);
  const handling = calls.filter((p) => p.includes("service changed"));
  assert.equal(handling.length, 2);
  assert.doesNotMatch(handling.find((p) => p.includes('"conversationId":"group-a"'))!, /b-private-interest/);
  assert.doesNotMatch(handling.find((p) => p.includes('"conversationId":"group-b"'))!, /a-private-interest/);
  const before = calls.length;
  await source.conversations.submit("shared", { origin: "source", originId: "personal.environments", sessionId: "group-b", text: "service changed" });
  await aide.settled(); assert.equal(calls.length, before);
  await source.conversations.submit("overlap", { origin: "source", originId: "personal.environments", sessionId: "group-a", text: "default is also rule-related" });
  await aide.settled(); assert.equal(calls.length, before + 1);
  assert.equal(aide.session("group-a").conversations.get("group-a")!.inputIds.filter((id) => id === "overlap").length, 1);
  await source.conversations.submit("unmatched", { origin: "source", originId: "personal.environments", text: "unmatched observation" });
  await aide.settled(); assert.equal(calls.length, before + 2);
  assert.equal(source.conversations.inputStore.get("unmatched")!.status.routing!.phase, "done");
  await aide.setDefaultConversation("group-a", false);
  await source.conversations.submit("ignored", { origin: "source", originId: "personal.environments", text: "no default or rule" });
  await aide.settled(); assert.equal(calls.length, before + 2);
  assert.equal(source.conversations.inputStore.get("ignored")!.status.routing!.phase, "ignored");
  assert.equal(aide.conversationIds().length, 3);
  assert.equal(source.conversations.inputStore.list().filter((i) => i.metadata.name === "shared").length, 1);
});

test("The first unscoped Source Input creates a replyable Conversation without semantic routing, and survives restart", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-first-source-"));
  const handled: string[] = []; let routes = 0;
  const options = fakeOptions({ async chief(prompt) {
    if (prompt.includes("Candidates:")) { routes++; return JSON.stringify({ conversationIds: [], reason: "unrelated" }); }
    handled.push(prompt); return "已接收观察";
  }, async execute() { throw new Error("No delegated work expected"); } }, root);
  let aide = new Aide(root, options, log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const source = aide.session("source:events");
  const client = source.plugins.resourceClient("personal");
  await assert.rejects(client.get({ ...CONVERSATION_TYPE, sessionId: "unknown", namespace: "v1", name: "missing" }), /Unknown Session/);
  assert.equal(aide.sessions().length, 1, "Reading an unknown Session must not create one");
  const spec = { origin: "source" as const, originId: "personal.environments", text: "同事希望确认发布窗口", observation: { kind: "mention" } };
  await source.conversations.submit("first", spec);
  await aide.settled();
  assert.equal(routes, 0); assert.equal(handled.length, 1);
  assert.equal(source.conversationIds().length, 0, "The observer execution Session is not the conversation destination");
  const [id] = aide.conversationIds(); assert.ok(id);
  const scope = aide.findConversation(id)!;
  assert.equal(scope.id, id);
  assert.equal(scope.conversations.get(id)!.name, spec.text);
  assert.deepEqual(scope.conversations.get(id)!.inputIds, ["first"]);
  const uid = scope.conversations.resource(id)!.metadata.uid;
  await aide.receive({ channelId: "web", id: "reply", sessionId: scope.id, text: "请帮我整理需要确认的问题" });
  await aide.settled();
  assert.equal(handled.length, 2); assert.equal(routes, 0);
  assert.doesNotMatch(handled[1]!, /Recent conversation:/, "Warm context receives only new inputs");
  assert.ok(handled[1]!.includes(`"conversationId":"${id}"`));
  assert.equal(scope.conversations.get(id)!.inputIds.length, 2);
  await aide.close(); aide = new Aide(root, options, log);
  await aide.start(); await aide.settled();
  await aide.session("source:events").conversations.submit("first", spec);
  await aide.settled();
  assert.equal(handled.length, 2); assert.equal(routes, 0);
  assert.equal(aide.findConversation(id)!.conversations.resource(id)!.metadata.uid, uid);
  await aide.session("source:events").conversations.submit("unmatched", { origin: "source", originId: "personal.environments", text: "不相关的新观察" });
  await aide.settled();
  assert.equal(routes, 0); assert.equal(aide.conversationIds().length, 1);
  assert.equal(aide.session("source:events").conversations.inputStore.get("unmatched")!.status.routing!.phase, "ignored");
});

test("Rule creation and association both run, including original discussion destinations", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-rule-create-"));
  const aide = new Aide(root, fakeOptions({ async chief(prompt) {
    assert.doesNotMatch(prompt, /Candidates:/); return "processed";
  }, async execute() { throw new Error("No Work"); } }, root), log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.session("existing").conversations.ensure();
  const source = aide.session("source");
  await source.conversations.submit("original", { origin: "source", originId: "personal.environments", sessionId: "existing", text: "prior evidence" });
  await aide.settled();
  await source.conversations.submit("new-topic", { origin: "source", originId: "personal.environments", sessionId: "new-target", text: "new service evidence", observation: { originalInputId: "original" } });
  await aide.settled();
  for (const id of ["existing", "new-target"]) {
    assert.equal(aide.findConversation(id)!.conversations.input("new-topic")!.status.phase, "done");
  }
  assert.equal(aide.conversationIds().length, 2);
  await source.conversations.submit("discussion", { origin: "source", originId: "personal.environments", text: "follow-up evidence", observation: { originalInputId: "new-topic" } });
  await aide.settled();
  for (const id of ["existing", "new-target"]) assert.equal(aide.findConversation(id)!.conversations.input("discussion")!.status.phase, "done");
  assert.equal(aide.conversationIds().length, 2);
});

test("Default and rule creation are appended before a later association fails; restart does not repeat their work", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-routing-partial-"));
  const calls: string[] = [];
  const options = fakeOptions({ async chief(prompt) { assert.doesNotMatch(prompt, /Candidates:/); calls.push(prompt); return "processed"; },
    async execute() { throw new Error("No Work"); } }, root);
  let aide = new Aide(root, options, log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const existing = aide.session("existing"), other = aide.session("other"), source = aide.session("source");
  await existing.conversations.ensure();
  const c = await other.conversations.ensure();
  await aide.setDefaultConversation("existing", true);
  const preceding = await source.conversations.submit("original", { origin: "source", originId: "personal.environments", text: "previous evidence" });
  source.conversations.inputStore.update(preceding, { routing: { phase: "running", reason: "previous delivery incomplete" } });
  await other.plugins.resourceClient("personal").replace(c, { ...c.spec, inputIds: ["original"] }, { ...c.status, processing: { original: { phase: "done" } } });
  const pending = await source.conversations.submit("pending", { origin: "source", originId: "personal.environments", sessionId: "new-target", text: "new evidence", observation: { originalInputId: "original" } });
  const resources = source.plugins.resourceClient("personal");
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  await assert.rejects(reconcileInput({ resources, logger }, pending), /Original Input routing is pending/);
  for (const id of ["existing", "new-target"]) {
    const scope = aide.findConversation(id)!;
    const c = scope.conversations.resource(id)!;
    assert.ok(c.spec.inputIds.includes("pending"));
    await scope.plugins.resourceClient("personal").patchStatus(c, { processing: { ...c.status.processing, pending: { phase: "done" } } });
  }
  assert.equal(source.conversations.inputStore.get("pending")!.status.routing!.phase, "running");
  assert.equal(other.conversations.input("pending"), undefined);
  const before = calls.length;
  const latest = source.conversations.inputStore.get("original")!;
  source.conversations.inputStore.update(latest, { routing: { ...latest.status.routing!, phase: "done" } });
  await aide.close(); aide = new Aide(root, options, log);
  await aide.start(); await aide.settled();
  assert.equal(calls.length, before + 1);
  assert.equal(aide.session("other").conversations.input("pending")!.status.phase, "done");
  assert.equal(aide.session("source").conversations.inputStore.get("pending")!.status.routing!.phase, "done");
});

for (const createdBeforeCrash of [false, true]) {
  test(`Restart resumes a creation ${createdBeforeCrash ? "after" : "before"} the empty Conversation was created without repeating work`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "aide-create-recovery-"));
    let handled = 0;
    const options = fakeOptions({ async chief(prompt) {
      assert.doesNotMatch(prompt, /Candidates:/); handled++; return "recovered";
    }, async execute() { throw new Error("No Work"); } }, root);
    let aide = new Aide(root, options, log);
    t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
    const a = aide.session("existing"), source = aide.session("source");
    await a.conversations.ensure();
    await aide.setDefaultConversation("existing", true);
    const ca = a.conversations.resource(a.id)!;
    const fact = await source.conversations.submit("recover", { origin: "source", originId: "personal.environments", sessionId: "created", text: "persisted creation" });
    source.conversations.inputStore.update(fact, { routing: { phase: "running", reason: "interrupted creation",
      creation: { sessionId: "created", name: digest("created") } } });
    await a.plugins.resourceClient("personal").replace(ca, { ...ca.spec, inputIds: ["recover"] }, { ...ca.status, processing: { recover: { phase: "done" } } });
    const created = createdBeforeCrash ? await aide.session("created").conversations.ensure() : undefined;
    await aide.close(); aide = new Aide(root, options, log);
    await aide.start(); await aide.settled();
    const c = aide.findConversation("created")!.conversations.resource("created")!;
    assert.equal(handled, 1);
    if (created) assert.equal(c.metadata.uid, created.metadata.uid);
    assert.deepEqual(c.spec.inputIds, ["recover"]);
    const routing = aide.session("source").conversations.inputStore.get("recover")!.status.routing!;
    assert.equal(routing.phase, "done"); assert.equal(routing.creation!.uid, c.metadata.uid);
    await aide.close(); aide = new Aide(root, options, log);
    await aide.start(); await aide.settled();
    assert.equal(handled, 1); assert.equal(aide.conversationIds().length, 2);
  });
}

for (const pinnedBeforeCrash of [false, true]) {
  test(`First-Conversation recovery ${pinnedBeforeCrash ? "after" : "before"} UID pinning preserves the shortcut and stable identity`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "aide-bootstrap-recovery-"));
    let handled = 0;
    const options = fakeOptions({ async chief(prompt) { assert.doesNotMatch(prompt, /Candidates:/); handled++; return "recovered"; },
      async execute() { throw new Error("No Work"); } }, root);
    let aide = new Aide(root, options, log);
    t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
    const source = aide.session("source");
    const fact = await source.conversations.submit("first", { origin: "source", originId: "personal.environments", text: "bootstrap evidence" });
    const id = `conversation:${digest(["input", "first"])}`;
    const created = await aide.session(id).conversations.ensure();
    source.conversations.inputStore.update(fact, { routing: { phase: "running", bootstrap: true, reason: "First Conversation",
      creation: { sessionId: id, name: created.metadata.name, ...(pinnedBeforeCrash ? { uid: created.metadata.uid } : {}) } } });
    await aide.session("later-default").conversations.ensure();
    await aide.setDefaultConversation("later-default", true);
    await aide.close(); aide = new Aide(root, options, log);
    await aide.start(); await aide.settled();
    assert.equal(aide.session(id).conversations.resource(id)!.metadata.uid, created.metadata.uid);
    assert.deepEqual(aide.session(id).conversations.get(id)!.inputIds, ["first"]);
    assert.deepEqual(aide.session("later-default").conversations.get("later-default")!.inputIds, []);
    assert.equal(handled, 1);
    assert.equal(aide.session("source").conversations.inputStore.get("first")!.status.routing!.phase, "done");
  });
}

test("Default append survives creation failure, and a pinned deleted creation is never replaced on retry", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-routing-create-failure-"));
  const aide = new Aide(root, fakeOptions({ async execute() { throw new Error("No Work"); } }, root), log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const inbox = aide.session("inbox"), source = aide.session("source");
  await inbox.conversations.ensure();
  await aide.setDefaultConversation("inbox", true);
  const fact = await source.conversations.submit("pending", { origin: "source", originId: "personal.environments", sessionId: "new", text: "new topic" });
  const resources = source.plugins.resourceClient("personal");
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  await assert.rejects(reconcileInput({ logger, resources: { ...resources, async create() {
    assert.deepEqual(inbox.conversations.get("inbox")!.inputIds, ["pending"], "Default must receive the Input before attempting creation");
    throw new Error("Creation unavailable");
  } } }, fact), /Creation unavailable/);
  assert.equal(source.conversations.inputStore.get("pending")!.status.routing!.phase, "running");
  const scope = aide.session("new"), created = await scope.conversations.ensure();
  const pending = source.conversations.inputStore.get("pending")!;
  source.conversations.inputStore.update(pending, { routing: { ...pending.status.routing!, creation: {
    sessionId: "new", name: created.metadata.name, uid: created.metadata.uid,
  } } });
  await scope.plugins.resourceClient("personal").delete(CONVERSATION_TYPE, created.metadata.name);
  scope.store.resources.finalizeDeletion(CONVERSATION_TYPE, created.metadata.name);
  const replacement = await scope.conversations.ensure();
  await assert.rejects(reconcileInput({ logger, resources }, fact), /Created Conversation no longer exists/);
  assert.notEqual(replacement.metadata.uid, created.metadata.uid);
  assert.deepEqual(scope.conversations.get("new")!.inputIds, []);
  assert.deepEqual(inbox.conversations.get("inbox")!.inputIds, ["pending"]);
});

test("Concurrent appends preserve both Inputs and consumption state; repeats do not write or wake a Conversation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-append-idempotency-"));
  const aide = new Aide(root, fakeOptions({ async execute() { throw new Error("No Work"); } }, root), log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const scope = aide.session("target"); const c = await scope.conversations.ensure();
  const first = await scope.conversations.submit("first", { origin: "source", originId: "personal.environments", text: "first" });
  const second = await scope.conversations.submit("second", { origin: "source", originId: "personal.environments", text: "second" });
  const client = scope.plugins.resourceClient("personal");
  const target = { sessionId: scope.id, name: c.metadata.name, uid: c.metadata.uid };
  await Promise.all([appendConversationInput(client, target, first), appendConversationInput(client, target, second), appendConversationInput(client, target, first)]);
  const current = scope.conversations.resource("target")!;
  assert.deepEqual([...current.spec.inputIds].sort(), ["first", "second"]);
  await client.patchStatus(current, { processing: { first: { phase: "done", quietReason: "already handled" } } });
  const before = scope.conversations.resource("target")!;
  let writes = 0;
  const resources = { ...client, replace: (async (...args: Parameters<typeof client.replace>) => { writes++; return client.replace(...args); }) as typeof client.replace };
  assert.equal(await appendConversationInput(resources, target, first), false);
  assert.equal(writes, 0);
  assert.deepEqual(scope.conversations.resource("target"), before);
  await client.delete(CONVERSATION_TYPE, c.metadata.name);
  await assert.rejects(appendConversationInput(client, target, first), /no longer exists/);
  scope.store.resources.finalizeDeletion(CONVERSATION_TYPE, c.metadata.name);
  const recreated = await scope.conversations.ensure();
  assert.notEqual(recreated.metadata.uid, target.uid);
  await assert.rejects(appendConversationInput(client, target, first), /no longer exists/);
  assert.deepEqual(scope.conversations.get("target")!.inputIds, []);
});

test("Restart retries rules without replaying completed conversation work", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-routing-recovery-"));
  let calls = 0;
  const options = fakeOptions({ async chief(prompt) { assert.doesNotMatch(prompt, /Candidates:/); calls++; return "resumed destination"; }, async execute() { throw new Error("No work"); } }, root);
  let aide = new Aide(root, options, log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const a = aide.session("a"), b = aide.session("b"), source = aide.session("source");
  await a.conversations.ensure();
  const cb = await b.conversations.ensure();
  await aide.setDefaultConversation("a", true);
  const ca = a.conversations.resource(a.id)!;
  const fact = await source.conversations.submit("event", { origin: "source", originId: "personal.environments", sessionId: "b", text: "recover fanout" });
  source.conversations.inputStore.update(fact, { routing: { phase: "running", reason: "interrupted after default append" } });
  await a.plugins.resourceClient("personal").replace(ca, { ...ca.spec, inputIds: ["event"] }, { ...ca.status, processing: { event: { phase: "done" } } });
  await aide.close();
  aide = new Aide(root, options, log); await aide.start(); await aide.settled();
  assert.equal(calls, 1);
  assert.equal(aide.session("a").conversations.get("a")!.inputIds.length, 1);
  assert.equal(aide.session("b").conversations.input("event")!.status.phase, "done");
  assert.equal(aide.session("source").conversations.inputStore.get("event")!.status.routing!.phase, "done");
  const client = aide.session("source").plugins.resourceClient("personal");
  const stale = await client.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, namespace: "v1", name: cb.metadata.name, uid: cb.metadata.uid, sessionId: "b" });
  assert.ok(stale);
  await client.patchStatus(stale, { receipts: [{ key: "test", responseId: "id" }] });
  await assert.rejects(client.replace(stale, stale.spec, stale.status), /version|conflict/i);
  assert.equal((await client.get({ ...INPUT_TYPE, namespace: "aide-system", name: "event" }))!.kind, "Input");
});


test("A committed Channel Input remains visible without a user Message and creates the Personal Conversation in the hinted Session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-channel-recovery-"));
  let calls = 0;
  const options = fakeOptions({ async chief(prompt) { assert.doesNotMatch(prompt, /Candidates:/); calls++; return "recovered"; }, async execute() { throw new Error("No Work"); } }, root);
  let aide = new Aide(root, options, log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  aide.session("target");
  await aide.session("source").conversations.submit("accepted", { origin: "channel", originId: "web", sessionId: "target", text: "question persisted before attachment" });
  await aide.close();
  aide = new Aide(root, options, log); await aide.start(); await aide.settled();
  assert.equal(calls, 1);
  assert.equal(aide.session("target").conversations.inputs().filter((input) => input.spec.text === "question persisted before attachment").length, 1);
  assert.equal(aide.session("target").conversations.input("accepted")!.status.phase, "done");
  await aide.close(); aide = new Aide(root, options, log); await aide.start(); await aide.settled();
  assert.equal(calls, 1); assert.equal(aide.messages().length, 1);
});
