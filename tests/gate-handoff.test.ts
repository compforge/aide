import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { parseUIModel } from "@compforge/agentue/ui";
import { processLink } from "../src/channel/process-link.ts";
import { mailReader } from "./stream-fixture.ts";
import { topicView } from "../src/channel/view.ts";
import { fakeOptions } from "./fake-harness.ts";
import { fixtureMe } from "./address-fixture.ts";
import { appendGateInput } from "../plugins/personal/gate/handoff.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { routeByRules } from "../plugins/personal/route/rules.ts";
import { larkAddress, webAddress } from "../src/channel/address.ts";
import { topicHistory } from "../plugins/personal/topic/history.ts";

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
  const link = processLink(aide.topics, aide.addresses, ref => aide.privateMeAddress(ref), "https://aide.example.com");
  const outputs = aide.outputs();
  for (const output of outputs) {
    const url = await link({ id: output.id, target: output.target, stream: mailReader("completed", 1) });
    if (output.text === "private reply") {
      assert(url); assert.equal(new URL(url).pathname, "/gate");
      assert.equal(new URL(url).searchParams.get("process"), output.executionId);
      assert.equal(new URL(url).searchParams.get("processTopicUid"), dm.status.topic!.uid);
    } else assert.equal(url, undefined, "Groups and other people's DMs never link to private Web process");
  }
  const privateOutput = outputs.find(o => o.text === "private reply")!;
  assert.equal(await processLink(aide.topics, aide.addresses, ref => aide.privateMeAddress(ref))({ id: privateOutput.id, target: privateOutput.target, stream: mailReader("completed", 1) }), undefined);

});

test("Gate forwards each user Input once per root and domain replies return to its original conversation", async t => {
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
  const forward = async (inputId: string, text: string) => appendGateInput(aide.personal.store, aide.topics.resource("gate")!, { inputId, topicUid: domain.metadata.uid, text });
  await resources.patchStatus(domain, { phase: "dormant" });
  const { inputId } = await forward("dm", "Investigate this domain");
  assert.equal((await forward("dm", "Investigate this domain")).inputId, inputId);
  assert.equal(aide.topics.resource("domain")!.status.phase, "active");
  assert.equal(aide.topics.resource("domain")!.status.compactOnWake, true);
  assert.equal(aide.topics.inputStore.get(inputId)!.spec.origin, "aide:handoff");
  assert.equal(aide.topics.inputStore.get(inputId)!.status.topic?.uid, domain.metadata.uid);
  await resources.patchStatus(domain, { execution: { id: "chief-execution", startedAt: new Date().toISOString() } });
  await resources.patchStatus(foreign, { execution: { id: "foreign-execution", startedAt: new Date().toISOString() } });
  await resources.patchStatus(aide.topics.inputStore.get(inputId)!, { assess: { topic: resourceRef(domain), executionId: "chief-execution", startedAt: new Date().toISOString() } });
  await assert.rejects(forward(inputId, "forward again"), /original user Input/);
  await assert.rejects(aide.topics.say("foreign", undefined, "foreign reply", "foreign-execution", { respondToInputId: inputId }), /not attached/);
  await aide.topics.say("domain", inputId, "Verified result", "chief-execution", { respondToInputId: inputId, idempotencyKey: "answer" });
  const output = aide.topics.outputStore.list()[0]!;
  assert.equal(output.spec.target.uid, source.spec.source!.uid);
  assert.equal(output.spec.replyToMessageId, "om_request");
  assert.deepEqual([...output.spec.receivers!].map(p => p.uid), [me.uid]);
  assert.equal(output.spec.conversation?.uid, gate.metadata.uid);
  assert.equal(topicHistory(aide.topics, gate, [gate]).outputs.length, 1);
  const next = await aide.topics.submit("followup", { origin: "channel", originId: "web", source: webAddress("gate"), sender: me, text: "Also check the new event" });
  await routeByRules(context, next);
  const followup = await forward("followup", next.spec.text);
  assert.notEqual(followup.inputId, inputId);
  const lateReply = await aide.topics.say("domain", followup.inputId, "New reply", "chief-execution", { respondToInputId: followup.inputId });
  const lateOutput = aide.topics.outputStore.get(lateReply.outputId)!;
  assert.equal(lateOutput.spec.target.uid, next.spec.source!.uid, "the latest followup selects its current direct channel");
  assert.equal(lateOutput.spec.conversation?.uid, gate.metadata.uid);
  // @spec Gate history must serialize pending user Inputs and domain replies without requiring retained delegated Inputs.
  const history = topicView(aide, "gate", undefined, { summaries: true });
  assert.doesNotThrow(() => parseUIModel(history));
  assert.equal(history.blocks.find(block => block.id === "input:followup")!.group_id, "followup");
  assert.equal(history.blocks.find(block => block.id === `message:${lateReply.outputId}`)!.group_id, "chief-execution");
  aide.topics.inputStore.storage.remove(aide.topics.inputStore.key(followup.inputId));
  assert.equal((await forward("followup", "Retry the same request")).inputId, followup.inputId);
  assert.equal(aide.topics.inputStore.get(followup.inputId), undefined);
  const originalInvocations = aide.invocations.bind(aide), originalView = aide.runtime.executions.view.bind(aide.runtime.executions);
  const queries: string[][] = [];
  aide.invocations = () => [{ invocationId: "domain-turn", pluginInstanceId: "personal", executionId: "chief-execution", verb: "harness", phase: "running", harnessName: "chief", topicId: "domain", resourceRef: resourceRef(domain) },
    { invocationId: "domain-previous", pluginInstanceId: "personal", executionId: "chief-execution", verb: "harness", phase: "failed", harnessName: "chief", topicId: "domain", resourceRef: resourceRef(domain) },
    { invocationId: "foreign-turn", pluginInstanceId: "personal", executionId: "foreign-execution", verb: "harness", phase: "running", harnessName: "chief", topicId: "foreign", resourceRef: resourceRef(foreign) }];
  aide.runtime.executions.view = ids => { queries.push([...ids]); return originalView(ids); };
  try {
    const transcript = topicView(aide, "gate", undefined, { summaries: true, process: false });
    assert.equal(queries.length, 0, "Main transcript never reads runtime process detail");
    assert(transcript.blocks.some(b => b.type === "message" && b.group_id === "chief-execution" && !b.lazy), "Foreign live replies keep streaming in Gate");
    const process = topicView(aide, "gate", undefined, { executionId: "chief-execution" });
    assert.deepEqual(queries, [["domain-turn", "domain-previous"]]);
    assert.deepEqual(process.blocks.filter(b => b.type === "execution").map(b => b.id), ["execution:domain-turn", "execution:domain-previous"]);
    assert.deepEqual(process.blocks.filter(b => b.type === "execution").map(b => b.status), ["running", "failed"], "Each invocation keeps its own phase");
    assert.equal(topicView(aide, "gate", undefined, { executionId: "foreign-execution" }).blocks.length, 0);
  } finally { aide.invocations = originalInvocations; aide.runtime.executions.view = originalView; }


});
