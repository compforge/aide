import { larkInputKey } from "../src/channel/lark/input-key.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TopicDefinition } from "../plugins/personal/topic/definition.ts";
import { TOPIC_TYPE } from "../plugins/personal/topic/model.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { personalAdmission } from "../plugins/personal/admission.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { INPUT_TYPE, InputAttention, type InputStatus, type InputSubmission } from "../plugins/personal/input/model.ts";
import { inputIdentity } from "../plugins/personal/input/identity.ts";
import { larkAddress } from "../src/channel/address.ts";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-message-identity-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const inputs = new InputStore(home), outputs = new OutputStore(home);
  const resources = createResourceClient(inputs.resources, undefined, undefined, personalAdmission(inputs, outputs));
  const source: InputSubmission = { inputKey: larkInputKey("oc_chat", "om_same"), origin: "source", originId: "personal.lark", topicKey: "lark:cli_observer:oc_chat",
    text: "Lark 私聊：给章进洲发你好", source: larkAddress("cli_observer", "oc_chat"),
    observation: { provider: "lark", accountId: "cli_observer", kind: "direct", message: { id: "om_same", chatId: "oc_chat" } } };
  const channel: InputSubmission = { inputKey: larkInputKey("oc_chat", "om_same"), origin: "channel", originId: "lark", topicKey: "lark:cli_bot:oc_chat",
    text: "给章进洲发你好", attention: InputAttention.Immediate, replyToMessageId: "om_same", source: larkAddress("cli_bot", "oc_chat"),
    observation: { provider: "lark", accountId: "cli_bot", messageId: "om_same", chatId: "oc_chat" } };
  const submit = (name: string, spec: InputSubmission) => resources.create<InputSubmission, InputStatus>(INPUT_TYPE, { name, spec });
  return { inputs, resources, source, channel, submit };
}

for (const order of ["source-first", "channel-first", "concurrent"] as const) {
  test(`One Lark sending event produces one Input across apps: ${order}`, async t => {
    const f = fixture(t);
    const specs = order === "channel-first" ? [f.channel, f.source] : [f.source, f.channel];
    const results = order === "concurrent"
      ? await Promise.all(specs.map((spec, i) => f.submit(`adapter-${i}`, spec)))
      : [await f.submit("adapter-a", specs[0]!), await f.submit("adapter-b", specs[1]!)];
    assert.equal(results[0]!.metadata.uid, results[1]!.metadata.uid);
    assert.equal(f.inputs.list().length, 1);
    const input = f.inputs.list()[0]!;
    assert.equal(input.metadata.name, inputIdentity(f.channel)!.name);
    assert.equal(input.spec.origin, "channel");
    assert.equal(input.spec.attention, InputAttention.Immediate);
    assert.equal(input.spec.replyToMessageId, "om_same");
    const { Addresses } = await import("../plugins/personal/address/service.ts");
    assert.deepEqual([...new Addresses(f.inputs.storage.home).read(input.spec.source!).spec.locators], [larkAddress("cli_bot", "oc_chat")]);
    const before = input.metadata.resourceVersion;
    await f.submit("another-source-account", { ...f.source, observation: { ...f.source.observation, accountId: "cli_third" } });
    await f.submit("channel-retry", f.channel);
    assert.equal(f.inputs.list()[0]!.metadata.resourceVersion, before);
  });
}

test("Late Channel admission preserves active or completed processing receipts and does not create another request", async t => {
  const f = fixture(t);
  f.inputs.storage.register("personal", [TopicDefinition]);
  const topic = f.inputs.resources.create({ type: TOPIC_TYPE, name: "root", spec: { id: "root" },
    status: { receipts: [], execution: { id: "chief-existing", startedAt: "2026-11-03T00:00:00Z" } } });
  let input = await f.submit("source", f.source);
  input = await f.resources.patchStatus(input, { topic: resourceRef(topic), assess: { topic: resourceRef(topic), executionId: "chief-existing", startedAt: "2026-11-03T00:00:00Z" } });
  const active = structuredClone(input.status);
  const promoted = await f.submit("channel", f.channel);
  assert.deepEqual(promoted.status, active);
  const completed = await f.resources.patchStatus(promoted, { assess: { ...active.assess, completedAt: "2026-11-03T00:01:00Z", result: { summary: "Already handled" } } });
  await f.submit("observed-again", f.source);
  await f.submit("channel-again", f.channel);
  assert.deepEqual(f.inputs.list()[0], completed);
  assert.equal(f.inputs.list().length, 1);
});

test("Message receipts suppress rediscovery after collection and restart", async t => {
  const f = fixture(t), accepted = await f.submit("source", f.source);
  f.inputs.storage.remove(f.inputs.key(accepted.metadata.name));
  const reopened = new InputStore(f.inputs.storage.home);
  const receipt = reopened.submit("bot", "channel", f.channel);
  assert.equal(receipt.metadata.uid, accepted.metadata.uid);
  assert.equal(receipt.metadata.creationTimestamp, accepted.metadata.creationTimestamp);
  assert.ok(receipt.status.route?.completedAt);
  assert.deepEqual(reopened.list(), []);
});

test("Identical text in different messages or chats remains independent; discussion batches retain their own identity", async t => {
  const f = fixture(t);
  await f.submit("first", f.channel);
  await f.submit("second", { ...f.channel, inputKey: larkInputKey("oc_chat", "om_second"), observation: { ...f.channel.observation, messageId: "om_second" } });
  await f.submit("another-chat", { ...f.channel, inputKey: larkInputKey("oc_another", "om_same"), source: larkAddress("cli_bot", "oc_another"), observation: { ...f.channel.observation, chatId: "oc_another" } });
  const discussion = { ...f.source, inputKey: "test:discussion:1", observation: { ...f.source.observation, kind: "discussion" } };
  await f.submit("discussion-1", discussion);
  await f.submit("discussion-2", { ...discussion, inputKey: "test:discussion:2", text: "New discussion facts" });
  assert.equal(f.inputs.list().length, 5);
});

for (const sourceFirst of [true, false]) test(`Real Personal intake activates Chief once when ${sourceFirst ? "Source" : "Channel"} arrives first`, async t => {
  const { Aide } = await import("../src/app.ts");
  const { fakeOptions } = await import("./fake-harness.ts");
  const { default: pino } = await import("pino");
  const home = mkdtempSync(join(tmpdir(), "aide-single-message-chief-"));
  let calls = 0;
  const aide = new Aide(home, fakeOptions({ notify: false, async chief() { calls++; return "handled"; },
    async execute() { throw new Error("No Work expected"); } }, home, [], home, "cli_bot"), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const source = () => resources.create<InputSubmission, InputStatus>(INPUT_TYPE, { name: "source-adapter", spec: {
    inputKey: larkInputKey("oc_shared", "om_shared"), origin: "source", originId: "personal.lark", source: larkAddress("cli_observer", "oc_shared"),
    topicKey: "lark:cli_observer:oc_shared", text: "hello", observation: { provider: "lark", accountId: "cli_observer", kind: "direct", message: { id: "om_shared", chatId: "oc_shared" } },
  } });
  const channel = () => aide.receive({ inputKey: larkInputKey("oc_shared", "om_shared"), id: "om_shared", channelId: "lark", source: larkAddress("cli_bot", "oc_shared"),
    topicKey: "lark:cli_bot:oc_shared", text: "hello", replyToMessageId: "om_shared", addressObservation: { type: "direct" },
    observation: { provider: "lark", accountId: "cli_bot", messageId: "om_shared", chatId: "oc_shared", sender: { type: "user", id: "ou_me" } } });
  if (sourceFirst) { await source(); await channel(); } else { await channel(); await source(); }
  await aide.settled();
  assert.equal(calls, 1);
  const input = aide.topics.inputStore.list().find(i => inputIdentity(i.spec));
  assert.ok(input); assert.equal(input.spec.origin, "channel");
  assert.equal(input.spec.attention, InputAttention.Immediate);
  assert.ok(input.status.assess?.completedAt);
  assert.equal(aide.topics.inputStore.list().filter(i => inputIdentity(i.spec)).length, 1);
  await source(); await channel(); await aide.settled();
  assert.equal(calls, 1, "Rediscovery after completion cannot execute the request again");
});

// @case Opaque keys deduplicate independently of platform evidence; no-key callers retain strict name identity.
test("Opaque inputKey works for arbitrary producers without platform observations", async t => {
  const f = fixture(t);
  const source: InputSubmission = { inputKey: "custom:event:42", origin: "source", originId: "custom.poll", text: "observed" };
  const first = await f.submit("poll-local-id", source);
  const second = await f.submit("push-local-id", { ...source, origin: "channel", originId: "custom.push", text: "direct" });
  assert.equal(first.metadata.uid, second.metadata.uid);
  assert.equal(second.spec.text, "direct");
  await f.submit("retry", { ...source, text: "observed again" });
  assert.equal(f.inputs.list().length, 1);
  const other = await f.submit("another-event", { ...source, inputKey: "custom:event:43" });
  assert.notEqual(other.metadata.uid, first.metadata.uid);
});

test("Without inputKey, name and content retain the existing admission contract", async t => {
  const f = fixture(t);
  const spec: InputSubmission = { origin: "source", originId: "custom", text: "same text" };
  const first = await f.submit("first", spec);
  assert.equal((await f.submit("first", spec)).metadata.uid, first.metadata.uid);
  assert.notEqual((await f.submit("second", spec)).metadata.uid, first.metadata.uid);
  await assert.rejects(f.submit("first", { ...spec, text: "changed" }), /different content/);
  await assert.rejects(f.submit("empty-key", { ...spec, inputKey: "" }), /inputKey/);
  await assert.rejects(f.submit("null-key", { ...spec, inputKey: null as unknown as string }), /inputKey/);
});
