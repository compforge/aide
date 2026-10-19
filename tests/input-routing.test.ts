import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { CONVERSATION_TYPE, type ConversationSpec, type ConversationStatus } from "../plugins/personal/conversation-model.ts";
import { INPUT_TYPE } from "@compforge/aide-plugin";
const log = pino({ level: "silent" });

test("Unscoped Input fans out across Sessions once; session hints and ignored observations avoid broadcasting", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-input-routing-"));
  const calls: string[] = []; let routing = 0;
  const aide = new Aide(root, fakeOptions({ async chief(prompt) {
    calls.push(prompt);
    if (prompt.includes("Candidates:")) {
      routing++;
      return JSON.stringify({ conversationIds: prompt.includes("irrelevant") ? [] : ["group-a", "group-b", "group-a"], reason: "related service interest" });
    }
    return "观察已处理";
  }, async execute() { throw new Error("No delegated work expected"); } }, root), log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive({ id: "a", sessionId: "group-a", text: "a-private-interest" });
  await aide.receive({ id: "b", sessionId: "group-b", text: "b-private-interest" });
  await aide.receive({ id: "c", sessionId: "group-c", text: "unrelated service" });
  await aide.settled(); assert.equal(routing, 0);
  const source = aide.session("source:events"); await source.start();
  await source.conversations.submit("shared", { origin: "source", text: "service changed" });
  await aide.settled();
  assert.equal(routing, 1);
  for (const id of ["group-a", "group-b"]) {
    const c = aide.findConversation(id)!.conversations;
    assert.equal(c.get(id)!.inputIds.filter((i) => i === "shared").length, 1);
    assert.equal(c.input("shared", id)!.status.phase, "done");
  }
  assert.equal(aide.findConversation("group-c")!.conversations.input("shared"), undefined);
  const handling = calls.filter((p) => p.includes("service changed") && !p.includes("Candidates:"));
  assert.equal(handling.length, 2);
  assert.doesNotMatch(handling.find((p) => p.includes('"conversationId":"group-a"'))!, /b-private-interest/);
  assert.doesNotMatch(handling.find((p) => p.includes('"conversationId":"group-b"'))!, /a-private-interest/);
  const before = aide.messages().length;
  await source.conversations.submit("shared", { origin: "source", text: "service changed" });
  await aide.settled(); assert.equal(aide.messages().length, before); assert.equal(routing, 1);
  await source.conversations.submit("hinted", { origin: "source", sessionId: "group-a", text: "known target" });
  await aide.settled(); assert.equal(routing, 1);
  assert.equal(aide.findConversation("group-a")!.conversations.input("hinted")!.status.phase, "done");
  await source.conversations.submit("quiet", { origin: "source", text: "irrelevant" });
  await aide.settled(); assert.equal(routing, 2);
  assert.equal(source.conversations.inputStore.get("quiet")!.status.routing!.phase, "ignored");
  assert.equal(aide.messages().length, before + 1);
  assert.equal(JSON.parse(readFileSync(join(root, "inputs.json"), "utf8")).filter((i: { id: string }) => i.id === "shared").length, 1);
});

test("Restart finishes a persisted fan-out plan without rerouting or replaying completed conversation work", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-routing-recovery-"));
  let calls = 0;
  const options = fakeOptions({ async chief(prompt) { assert.doesNotMatch(prompt, /Candidates:/); calls++; return "resumed destination"; }, async execute() { throw new Error("No work"); } }, root);
  let aide = new Aide(root, options, log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const a = aide.session("a"), b = aide.session("b"), source = aide.session("source");
  const ca = await a.conversations.ensure(), cb = await b.conversations.ensure();
  const fact = await source.conversations.submit("event", { origin: "source", text: "recover fanout" });
  source.conversations.inputStore.update(fact, { routing: { phase: "planned", reason: "persisted decision",
    targets: [ca, cb].map((c) => ({ sessionId: c.spec.sessionId, name: c.metadata.name, uid: c.metadata.uid })) } });
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


test("A committed Channel Input restores its user message and creates the Personal Conversation in the hinted Session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-channel-recovery-"));
  let calls = 0;
  const options = fakeOptions({ async chief(prompt) { assert.doesNotMatch(prompt, /Candidates:/); calls++; return "recovered"; }, async execute() { throw new Error("No Work"); } }, root);
  let aide = new Aide(root, options, log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  aide.session("target");
  await aide.session("source").conversations.submit("accepted", { origin: "channel", sessionId: "target", text: "question persisted before attachment" });
  await aide.close();
  aide = new Aide(root, options, log); await aide.start(); await aide.settled();
  assert.equal(calls, 1);
  assert.equal(aide.messages().filter((m) => m.role === "user" && m.text === "question persisted before attachment").length, 1);
  assert.equal(aide.session("target").conversations.input("accepted")!.status.phase, "done");
  await aide.close(); aide = new Aide(root, options, log); await aide.start(); await aide.settled();
  assert.equal(calls, 1); assert.equal(aide.messages().length, 2);
});
