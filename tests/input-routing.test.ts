import { fixtureAddress } from "./address-fixture.ts";
import { fixtureIncoming } from "./address-fixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { CONVERSATION_TYPE, type ConversationSpec, type ConversationStatus } from "../plugins/personal/conversation/model.ts";
import { routeTo } from "./input-state-fixture.ts";
import { INPUT_TYPE } from "../plugins/personal/input/model.ts";
const log = pino({ level: "silent" });

test("Concurrent appends preserve both Inputs and consumption state; repeats do not write or wake a Conversation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-append-idempotency-"));
  const aide = new Aide(root, fakeOptions({ async execute() { throw new Error("No Work"); } }, root), log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const scope = aide.personal; const c = await scope.conversations.ensure("target");
  const first = await scope.conversations.submit("first", { origin: "source", originId: "personal.environments", text: "first" });
  const second = await scope.conversations.submit("second", { origin: "source", originId: "personal.environments", text: "second" });
  const client = scope.plugins.resourceClient("personal");
  const target = { name: c.metadata.name, uid: c.metadata.uid };
  await Promise.all([routeTo(client, target, first), routeTo(client, target, second), routeTo(client, target, first)]);
  const current = scope.conversations.resource("target")!;
  assert.deepEqual(scope.conversations.get("target")!.pendingInputIds.sort(), ["first", "second"]);
  const fact = scope.conversations.inputStore.get("first")!;
  scope.conversations.inputStore.update(fact, { assess: { ...fact.status.assess, [c.metadata.uid]: { ...fact.status.assess![c.metadata.uid]!, completedAt: new Date().toISOString() } } });
  const before = scope.conversations.resource("target")!;
  let writes = 0;
  const resources = { ...client, replace: (async (...args: Parameters<typeof client.replace>) => { writes++; return client.replace(...args); }) as typeof client.replace };
  assert.equal(await routeTo(resources, target, first), false);
  assert.equal(writes, 0);
  assert.deepEqual(scope.conversations.resource("target"), before);
  await client.delete(CONVERSATION_TYPE, c.metadata.name);
  assert.equal(await routeTo(client, target, first), false);
  scope.store.resources.finalizeDeletion(CONVERSATION_TYPE, c.metadata.name);
  const recreated = await scope.conversations.ensure("target");
  assert.notEqual(recreated.metadata.uid, target.uid);
  assert.equal(await routeTo(client, target, first), false);
  assert.deepEqual(scope.conversations.inputs("target").map((i) => i.metadata.name), []);
});

test("Restart retries rules without replaying completed conversation work", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-routing-recovery-"));
  let calls = 0;
  const options = fakeOptions({ async chief(prompt) { assert.doesNotMatch(prompt, /Candidates:/); calls++; return "resumed destination"; }, async execute() { throw new Error("No work"); } }, root);
  let aide = new Aide(root, options, log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const a = aide.personal, b = aide.personal, source = aide.personal;
  await a.conversations.ensure("a");
  const cb = await b.conversations.ensure("b");
  await aide.setDefaultConversation("a", true);
  const ca = a.conversations.resource("a")!;
  const fact = await source.conversations.submit("event", { origin: "source", originId: "personal.environments", sessionId: "b", text: "recover fanout" });

  await aide.close();
  aide = new Aide(root, options, log); await aide.start(); await aide.settled();
  assert.equal(calls, 1);
  assert.equal(aide.personal.conversations.inputs("a").map((i) => i.metadata.name).length, 0);
  assert.equal(aide.personal.conversations.input("event", "b")!.consumption.phase, "done");
  assert.ok(aide.personal.conversations.inputStore.get("event")!.status.route?.completedAt);
  const client = aide.personal.plugins.resourceClient("personal");
  const stale = await client.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, namespace: "v1", name: cb.metadata.name, uid: cb.metadata.uid });
  assert.ok(stale);
  await client.patchStatus(stale, { receipts: [{ key: "test", responseId: "id" }] });
  await assert.rejects(client.replace(stale, stale.spec, stale.status), /version|conflict/i);
  assert.equal((await client.get({ ...INPUT_TYPE, namespace: "v1", name: "event" }))!.kind, "Input");
});


test("A committed Channel Input remains visible without a user Message and creates the Personal Conversation in the hinted Session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-channel-recovery-"));
  let calls = 0;
  const options = fakeOptions({ async chief(prompt) { assert.doesNotMatch(prompt, /Candidates:/); calls++; return "recovered"; }, async execute() { throw new Error("No Work"); } }, root);
  let aide = new Aide(root, options, log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  aide.personal;
  await aide.personal.conversations.submit("accepted", { origin: "channel", originId: "web", source: fixtureAddress("target"), sessionId: "target", text: "question persisted before attachment" });
  await aide.close();
  aide = new Aide(root, options, log); await aide.start(); await aide.settled();
  assert.equal(calls, 1);
  assert.equal(aide.personal.conversations.inputs().filter((input) => input.spec.text === "question persisted before attachment").length, 1);
  assert.equal(aide.personal.conversations.input("accepted", "target")!.consumption.phase, "done");
  await aide.close(); aide = new Aide(root, options, log); await aide.start(); await aide.settled();
  assert.equal(calls, 1); assert.equal(aide.outputs().length, 1);
});
