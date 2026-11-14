import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { parseUIModel } from "@compforge/agentue/ui";
import { topicView } from "../src/channel/view.ts";
import { fakeOptions } from "./fake-harness.ts";
import { fixtureMe } from "./address-fixture.ts";
import { Handoffs } from "../plugins/personal/handoff/service.ts";
import { reconcileHandoff } from "../plugins/personal/handoff/reconcile.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { routeByRules } from "../plugins/personal/route/rules.ts";
import { larkAddress, webAddress } from "../src/channel/address.ts";
import { topicHistory } from "../plugins/personal/topic/history.ts";
import { TOPIC_TYPE } from "../plugins/personal/topic/model.ts";
import { migrateGateTree } from "../plugins/personal/gate/topic.ts";
import { digest } from "../plugins/personal/chief-model.ts";

const log = pino({ level: "silent" });

test("only Me bot DM enters Gate; Me group mention and other senders remain domain inputs", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-gate-dm-"));
  let gateCalls = 0, chiefCalls = 0;
  const options = fakeOptions({ async gate() { gateCalls++; return "private reply"; }, async chief() { chiefCalls++; return "domain reply"; }, async execute() { throw new Error("No Work"); } }, home, [], home, "cli_test");
  options.config.channels.test = { ...options.config.channels.test!, me: { openId: "ou_me" } };
  const aide = new Aide(home, options, log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const send = async (id: string, sender: string, chatType: "p2p" | "group") => {
    const receipt = await aide.receive({ id, channelId: "lark", topicKey: "chat-" + id, text: id,
      source: larkAddress("cli_test", "oc_" + id), addressObservation: { type: chatType === "p2p" ? "direct" : "group" },
      observation: { provider: "lark", accountId: "cli_test", chatType, sender: { id: sender, type: "user" }, mentions: ["ou_aide"] } });
    await aide.settled(); return aide.topics.inputStore.get(receipt.inputId)!;
  };
  const dm = await send("private", "ou_me", "p2p");
  assert.equal(dm.status.topic?.uid, aide.topics.resource("gate")!.metadata.uid);
  const group = await send("group", "ou_me", "group"), other = await send("other", "ou_peer", "p2p");
  assert.notEqual(group.status.topic?.uid, dm.status.topic?.uid);
  assert.notEqual(other.status.topic?.uid, dm.status.topic?.uid);
  assert.equal(gateCalls, 1); assert.equal(chiefCalls, 2);
  assert.deepEqual(aide.outputs().find(o => o.text === "private reply")?.target, larkAddress("cli_test", "oc_private"));
});

test("durable handoff deduplicates, replies on original DM, tracks followups and fences stale or foreign reports", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-handoff-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No inference"); } }, home, [], home, "cli_test"), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.personal.store.client, context = { resources, logger: { info() {} } };
  const me = await fixtureMe(aide);
  const domain = await aide.topics.ensure("domain"), foreign = await aide.topics.ensure("foreign");
  const gate = aide.topics.resource("gate")!;
  await resources.patchStatus(gate, { execution: { id: "gate-execution", startedAt: new Date().toISOString() } });
  const source = await aide.topics.submit("dm", { origin: "channel", originId: "lark", relation: "sent", observation: { chatType: "p2p" },
    source: larkAddress("cli_test", "oc_me"), sender: me, replyToMessageId: "om_request", text: "Investigate the domain" });
  await routeByRules(context, source);
  const service = new Handoffs(aide.personal.store, log), activeGate = () => aide.topics.resource("gate")!;
  const args = { inputId: "dm", topicUid: domain.metadata.uid, title: "Investigation", request: "Investigate this domain" };
  const handoff = await service.delegate(activeGate(), args);
  assert.equal((await service.delegate(activeGate(), args)).metadata.uid, handoff.metadata.uid);
  assert.equal(aide.topics.inputStore.list().filter(i => i.spec.handoff).length, 1);
  const inputId = handoff.status.latestInputId;
  assert.equal(aide.topics.inputStore.get(inputId)!.status.topic?.uid, domain.metadata.uid);
  await resources.patchStatus(domain, { execution: { id: "chief-execution", startedAt: new Date().toISOString() } });
  await resources.patchStatus(foreign, { execution: { id: "foreign-execution", startedAt: new Date().toISOString() } });
  await resources.patchStatus(aide.topics.inputStore.get(inputId)!, { assess: { topic: resourceRef(domain), executionId: "chief-execution", startedAt: new Date().toISOString() } });
  await reconcileHandoff({ resources }, service.read(handoff.metadata.name));
  const accepted = service.read(handoff.metadata.name);
  assert.equal(accepted.status.phase, "accepted");
  await reconcileHandoff({ resources }, accepted);
  assert.equal(service.read(handoff.metadata.name).metadata.resourceVersion, accepted.metadata.resourceVersion,
    "unchanged admission receipts must not rewrite Handoff status");
  const report = { id: handoff.metadata.name, inputId, phase: "completed", report: "Verified" };
  await assert.rejects(service.report(aide.topics.resource("foreign")!, report, "bad"), /outside/);
  await aide.topics.say("domain", inputId, "Verified result", "chief-execution", { respondToInputId: inputId, idempotencyKey: "answer" });
  const output = aide.topics.outputStore.list()[0]!;
  assert.equal(output.spec.target.uid, source.spec.source!.uid);
  assert.equal(output.spec.replyToMessageId, "om_request");
  assert.deepEqual([...output.spec.receivers!].map(p => p.uid), [me.uid]);
  assert.equal(output.spec.conversation?.uid, gate.metadata.uid);
  assert.equal(topicHistory(aide.topics, gate, [gate]).outputs.length, 1);
  await service.report(aide.topics.resource("domain")!, report, "report");
  assert.equal(service.read(handoff.metadata.name).status.phase, "completed");
  assert.equal(aide.topics.inputStore.query("topic", gate.metadata.uid).length, 1, "normal reply/report never wakes Gate");
  const next = await aide.topics.submit("followup", { origin: "channel", originId: "web", source: webAddress("gate"), sender: me, text: "Also check the new event" });
  await routeByRules(context, next);
  await service.followup(activeGate(), { id: handoff.metadata.name, inputId: "followup", request: next.spec.text });
  await service.followup(activeGate(), { id: handoff.metadata.name, inputId: "followup", request: next.spec.text });
  const latest = service.read(handoff.metadata.name);
  assert.equal(latest.status.sequence, 2);
  await assert.rejects(service.report(aide.topics.resource("domain")!, report, "late"), /newer follow-up/);
  const waiting = { id: latest.metadata.name, inputId: latest.status.latestInputId, phase: "waiting", report: "Need user's choice", coordinate: true };
  await service.report(aide.topics.resource("domain")!, waiting, "coordinate");
  await service.report(aide.topics.resource("domain")!, waiting, "coordinate");
  const notices = aide.topics.inputStore.list().filter(i => i.spec.originId === "personal.handoff");
  assert.equal(notices.length, 1);
  await assert.rejects(service.delegate(activeGate(), { ...args, inputId: notices[0]!.metadata.name }), /original user Input/);
  await assert.rejects(resources.delete(TOPIC_TYPE, domain.metadata.name), /active handoffs/);
  aide.topics.inputStore.storage.remove(aide.topics.inputStore.key(latest.status.latestInputId));
  await assert.rejects(aide.topics.say("foreign", undefined, "wrong owner", "foreign-execution", { respondToHandoffId: latest.metadata.name }), /outside/);
  const lateReply = await aide.topics.say("domain", latest.status.latestInputId, "Result after Input expiry", "chief-execution", { respondToHandoffId: latest.metadata.name });
  const lateOutput = aide.topics.outputStore.get(lateReply.outputId)!;
  assert.equal(lateOutput.spec.target.uid, next.spec.source!.uid, "the latest followup selects its current direct channel");
  assert.equal(lateOutput.spec.conversation?.uid, gate.metadata.uid);
  // @spec Gate history must serialize pending user Inputs and domain replies without requiring retained delegated Inputs.
  const history = topicView(aide, "gate", undefined, { summaries: true });
  assert.doesNotThrow(() => parseUIModel(history));
  assert.equal(history.blocks.find(block => block.id === "input:followup")!.group_id, "followup");
  assert.equal(history.blocks.find(block => block.id === `message:${lateReply.outputId}`)!.group_id, "chief-execution");
  await service.report(aide.topics.resource("domain")!, { ...waiting, phase: "completed", coordinate: false }, "finished-after-expiry");
  await service.followup(activeGate(), { id: latest.metadata.name, inputId: "followup", request: next.spec.text });
  assert.equal(service.read(latest.metadata.name).status.sequence, 2, "expired delegated Inputs retain replay receipts");
  assert.ok(!("sourceText" in (await service.list(gate.metadata.uid)).items[0]!.spec), "background listings do not copy original user evidence");
});

test("legacy root migration preserves UID and session, with independent execution and knowledge scope", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-gate-migrate-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No inference"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const store = aide.topics.resources;
  const root = store.create({ type: TOPIC_TYPE, name: digest("legacy"), spec: { id: "legacy" },
    status: { receipts: [], agent: { harness: "chief", sessionId: "preserved" } } });
  await migrateGateTree(aide.personal.store.client);
  await migrateGateTree(aide.personal.store.client);
  const updated = aide.topics.resource("legacy")!, gate = aide.topics.resource("gate")!;
  assert.equal(updated.metadata.uid, root.metadata.uid);
  assert.equal(updated.status.agent?.sessionId, "preserved");
  assert.equal(updated.spec.parentRef?.uid, gate.metadata.uid);
  assert.deepEqual(aide.topics.scope(gate.metadata.uid).map(t => t.metadata.uid), [gate.metadata.uid]);
  assert.deepEqual(aide.topics.scope(root.metadata.uid).map(t => t.metadata.uid), [root.metadata.uid]);
  const { writeSummary } = await import("../plugins/personal/note/summary.ts");
  await assert.rejects(writeSummary(aide.personal.store.client, gate, { text: "duplicate domain knowledge" }), /not domain Notes/);
});
