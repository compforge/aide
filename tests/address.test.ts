import { InputAttention } from "../plugins/personal/input/model.ts";
import { once } from "node:events";
import { httpChannel } from "../src/api/index.ts";
import { browseTopics } from "../plugins/personal/topic/browse.ts";
import { topicView } from "../src/channel/view.ts";
import { visibleOutput } from "../src/channel/output.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pino from "pino";
import type { Address, ChannelAddress } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { parseAddress } from "../src/address.ts";
import { larkAddress, larkEndpoint, larkTopicLocator, webAddress } from "../src/channel/address.ts";
import { fakeOptions } from "./fake-harness.ts";
import { seedInput } from "./topic-fixture.ts";

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "aide-address-"));
  const options = fakeOptions({ async execute() { throw new Error("Unexpected Work"); } }, root, [], root, "app");
  const aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  return { aide, root, options };
}

/** @case External observations cannot become direct reply paths, even when urgent; an existing contact path still permits notifications. */
test("Source addresses never supply direct or urgency-based reply destinations", async t => {
  const { aide } = setup(t);
  const store = aide.personal.topics;
  const observed = larkAddress("app", "observed-group"), contact = webAddress("contact");
  await store.ensure("observations");
  await seedInput(store, "external", { topicId: "observations", origin: "source", originId: "personal.lark",
    source: observed, attention: InputAttention.Immediate, relation: "sent", text: "Me asks a colleague a question" });
  const before = store.outputs().length;
  await assert.rejects(store.say("observations", "external", "unsolicited reply", undefined, { respondToInputId: "external" }), /Direct replies require a Channel Input/);
  assert.equal(store.outputs().length, before);
  await aide.persons.initialize();
  const fallback = await store.say("observations", "external", "Notify Me rather than the observed group");
  assert.deepEqual(store.outputStore.get(fallback.outputId)!.spec.target, webAddress("observations"));
  const explicit = await store.say("observations", "external", "Aide's suggestion", undefined, { target: contact });
  assert.deepEqual(store.outputStore.get(explicit.outputId)!.spec.target, contact);
  await store.ensure("known-contact", contact);
  await seedInput(store, "urgent-observation", { topicId: "known-contact", origin: "source", originId: "personal.lark",
    source: observed, attention: InputAttention.Immediate, text: "external change" });
  const notification = await store.say("known-contact", "urgent-observation", "Update within an existing mandate");
  assert.deepEqual(store.outputStore.get(notification.outputId)!.spec.target, webAddress("known-contact"), "Topic address does not override default contact");
});

test("ChannelAddress extends Address and owns canonical endpoint encoding and admission", () => {
  const channel: ChannelAddress = larkAddress("app/one", "chat:二/%");
  const address: Address = channel;
  assert.deepEqual(parseAddress(address), channel);
  assert.deepEqual(larkEndpoint(address), { appId: "app/one", receiveId: "chat:二/%", receiveIdType: "chat_id" });
  assert.equal(larkEndpoint(webAddress("topic")), undefined);
  for (const target of [
    { kind: "email", endpoint: "someone@example.com" },
    { kind: "channel", channelId: "unknown", endpoint: "chat" },
    { kind: "channel", channelId: "lark", endpoint: "app/chat/extra" },
    { kind: "channel", channelId: "lark", endpoint: "app/%zz" },
    { kind: "channel", channelId: "lark", endpoint: "app/%63hat" },
    { kind: "channel", channelId: "web", endpoint: "" },
  ]) assert.throws(() => parseAddress(target));
});

/** @case Topic identity and communication destination vary independently; default forwarding cannot change either Topic's address. */
test("Channel creation captures its first address, bypasses Default and subsequent Inputs cannot rebind it", async (t) => {
  const { aide } = setup(t);
  const inbox = webAddress("inbox"), group = larkAddress("app", "group"), elsewhere = larkAddress("app", "elsewhere");
  await aide.receive({ id: "hello", channelId: "web", topicId: "inbox", text: "hello", source: inbox });
  await aide.settled(); await aide.topics.ensure("default");
  await aide.receive({ id: "first", channelId: "lark", topicId: "opaque-topic", topicName: "群名称", text: "first", source: group });
  await aide.settled();
  const topic = aide.personal.topics;
  assert.deepEqual(topic.resource("opaque-topic")!.spec.address, group);
  assert.equal(topic.resource("opaque-topic")!.spec.name, "群名称");
  assert.deepEqual(aide.personal.topics.resource("inbox")!.spec.address, inbox);
  const replies = aide.outputStore.list().filter(o => (o.spec.target as ChannelAddress).endpoint === group.endpoint);
  assert.equal(replies.length, 1, "Only the explicit topic replies; Default receives no copy");
  await aide.receive({ id: "second", channelId: "lark", topicId: "opaque-topic", topicName: "不能覆盖已有名称", text: "second", source: elsewhere });
  await aide.settled();
  assert.deepEqual(topic.resource("opaque-topic")!.spec.address, group);
  assert.equal(topic.resource("opaque-topic")!.spec.name, "群名称");
  assert.ok(aide.outputStore.list().some((o) => o.spec.topicId === "opaque-topic" && (o.spec.target as ChannelAddress).endpoint === elsewhere.endpoint));
  await assert.rejects(aide.receive({ id: "wrong", channelId: "web", topicId: "must-not-exist", text: "wrong", source: group }), /different Channel/);
  assert.equal(aide.topics.get("must-not-exist"), undefined);
});

/** @case An observation knows where it happened without establishing a standing contact address. */
test("An addressless Topic stays addressless after Source and Channel append; direct replies use the Input", async (t) => {
  const { aide, root, options } = setup(t);
  const address = larkAddress("app", "group");
  await aide.topics.ensure("topic");
  await aide.personal.topics.submit("observed", { origin: "source", originId: "personal.lark", topicId: "topic", source: address, text: "observed fact" });
  await aide.settled();
  const c = aide.personal.topics;
  assert.equal(c.resource("topic")!.spec.address, undefined);
  assert.equal(aide.outputs().length, 0);
  await aide.receive({ id: "request", channelId: "lark", topicId: "topic", text: "reply here", source: address });
  await aide.settled();
  assert.equal(c.resource("topic")!.spec.address, undefined);
  assert.deepEqual(aide.outputStore.list()[0]!.spec.target, address);
  assert.equal(aide.outputStore.list()[0]!.status.disclosure?.decision, "denied", "Unknown actual audience is privately reported to Me");
  await aide.close();
  const reopened = new Aide(root, options, pino({ level: "silent" }));
  try {
    await reopened.start(); await reopened.settled();
    assert.equal(reopened.personal.topics.resource("topic")!.spec.address, undefined);
    assert.deepEqual(reopened.outputStore.list()[0]!.spec.target, address);
  } finally { await reopened.close(); }
});

/** @case Rules reply to an unambiguous source; explicit Agent decisions win, and unresolved destinations fall back to Me. */
test("say resolves direct, aggregate and proactive targets without guessing from IDs or consuming Inputs", async (t) => {
  const { aide } = setup(t);
  const scope = aide.personal, store = scope.topics;
  const a = larkAddress("app", "a"), b = larkAddress("app", "b");
  await seedInput(store, "a", { origin: "channel", originId: "lark", source: a, topicId: "mixed", text: "a" });
  await seedInput(store, "b", { origin: "channel", originId: "lark", source: b, topicId: "mixed", text: "b" });
  await scope.plugins.resourceClient("personal").patchStatus(store.resource("mixed")!, { execution: { id: "run", startedAt: new Date().toISOString() } });
  await aide.persons.initialize();
  const fallback = await store.say("mixed", undefined, "unable to choose", "run");
  assert.deepEqual(store.outputStore.get(fallback.outputId)!.spec.target, webAddress("mixed"));
  const rule = await store.say("mixed", undefined, "reply to a", "run", { inputIds: ["a"] });
  assert.deepEqual(store.outputStore.get(rule.outputId)!.spec.target, a);
  const options = { respondToInputId: "b", idempotencyKey: "tool-1" };
  const first = await store.say("mixed", undefined, "reply to b", "run", options);
  assert.deepEqual(await store.say("mixed", undefined, "reply to b", "run", options), first);
  assert.deepEqual(store.outputStore.get(first.outputId)!.spec.target, b);
  assert.deepEqual(store.outputStore.get(first.outputId)!.spec.inputIds, ["b"]);
  const aggregate = await store.say("mixed", undefined, "aggregate", "run", { target: a, inputIds: ["a", "b"] });
  assert.deepEqual(store.outputStore.get(aggregate.outputId)!.spec.inputIds, ["a", "b"]);
  assert.deepEqual(store.outputStore.get(aggregate.outputId)!.spec.target, a);
  assert.deepEqual(store.get("mixed")!.pendingInputIds, ["a", "b"]);
  await assert.rejects(store.say("mixed", undefined, "conflict", "run", { target: a, respondToInputId: "b" }), /not both/);
  await store.ensure("addressless");
  await aide.persons.initialize();
  const defaultReply = await store.say("addressless", undefined, "contact me");
  assert.deepEqual(store.outputStore.get(defaultReply.outputId)!.spec.target, webAddress("addressless"));
  const proactive = await store.say("addressless", undefined, "proactive", undefined, { target: b });
  assert.deepEqual(store.outputStore.get(proactive.outputId)!.spec.target, b);
  assert.equal(store.outputStore.get(proactive.outputId)!.spec.inputIds, undefined);
});

test("Routine without a communication address retains reported evidence without rerunning after restart", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-addressless-work-"));
  let executions = 0;
  const options = fakeOptions({ async execute() { executions++; return { action: "done", report: "verified", notification: "retained notification", question: null, nextAt: null }; } }, root);
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.work("source-topic").create({ kind: "routine", title: "Check", instruction: "Inspect", trigger: { cron: null, timezone: "UTC", event: "check" } });
  await aide.event({ id: "check",  topicId: "source-topic", name: "check", text: "check" });
  await aide.start(); await aide.settled();
  assert.equal(aide.works()[0]!.status, "scheduled");
  assert.equal(aide.works()[0]!.lastReport!.text, "verified");
  assert.equal(aide.outputs().length, 0);
  await aide.close(); aide = new Aide(root, options, pino({ level: "silent" }));
  await aide.start(); await aide.settled();
  assert.equal(executions, 1);
  assert.equal(aide.works()[0]!.status, "scheduled");
});

/** @case Web publication uses its target too, while the producer keeps an inspectable record. */
test("Web displays explicitly addressed Output in the receiving endpoint and excludes earlier destination history", async (t) => {
  const { aide } = setup(t);
  const store = aide.personal.topics;
  await aide.personal.topics.ensure("recipient", webAddress("recipient"));
  const result = await store.say("producer", undefined, "delivered to recipient", undefined, { target: webAddress("recipient") });
  await aide.persons.initialize(); await aide.reconcileOutput(result.outputId);
  for (const id of ["producer", "recipient"]) {
    assert.ok(topicView(aide, id).blocks.some((b) => b.content === "delivered to recipient"));
    assert.equal(browseTopics(aide.topics).items.find((c) => c.id === id)!.preview, "delivered to recipient");
  }
  const recipient = aide.personal.topics.resource("recipient")!;
  const output = aide.outputs().find((o) => o.id === result.outputId)!;
  assert.equal(visibleOutput({ ...output, at: "2000-01-01T00:00:00.000Z" }, recipient), false);
  const producer = store.resource("producer")!;
  assert.equal(visibleOutput({ ...output, topicUid: "old-incarnation" }, producer), false);
  const server = httpChannel(aide, pino({ level: "silent" }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/messages?topicId=recipient`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as Array<{ id: string }>).map((o) => o.id), [result.outputId]);
  } finally { server.closeAllConnections(); server.close(); }
});


/** @case Content authors, intended people and delivery addresses are independent, including explicit overrides and broadcasts. */
test("say retains receiver Persons through the Chief tool, storage, projection and Printer", async (t) => {
  const { aide, root } = setup(t);
  const { personRef } = await import("../plugins/personal/person/model.ts");
  const { chiefTools } = await import("../agents/chief/chief-tools.ts");
  const { emptyConnectors } = await import("../src/connector/client.ts");
  const { outputPrinter } = await import("../plugins/personal/output/printer.ts");
  const { inputPrinter } = await import("../plugins/personal/input/printer.ts");
  const { OutputStore } = await import("../plugins/personal/output/store.ts");
  const sender = personRef(await aide.persons.observe({ provider: "lark", scope: "cli_app", id: "ou_sender" }, "张三"));
  const manager = personRef(await aide.persons.observe({ provider: "lark", scope: "cli_app", id: "ou_manager" }, "李四"));
  const scope = aide.personal, store = scope.topics;
  const source = larkAddress("app", "group"), target = larkAddress("app", "reporting-group");
  await seedInput(store, "question", { topicId: "topic", origin: "channel", originId: "lark", sender, source, text: "请帮我确认进展" });
  const say = chiefTools(emptyConnectors, (id, input) => store.say("topic", undefined, input.text, undefined, { ...input, idempotencyKey: id })).find((tool) => tool.name === "say")!;
  const reply = await say.execute("reply", { text: "确认了", respondToInputId: "question" }, undefined, undefined, {} as never);
  const direct = aide.outputs().find((output) => output.text === "确认了")!;
  assert.deepEqual(direct.receivers, [sender]); assert.deepEqual(direct.target, source);
  assert.deepEqual(await say.execute("reply", { text: "确认了", respondToInputId: "question" }, undefined, undefined, {} as never), reply);
  await say.execute("report", { text: "综合进展", target, receivers: [manager, sender], inputIds: ["question"] }, undefined, undefined, {} as never);
  const report = aide.outputs().find((output) => output.text === "综合进展")!;
  const receivers = [manager, sender].sort((a, b) => a.uid! < b.uid! ? -1 : 1);
  assert.deepEqual(report.receivers, receivers); assert.deepEqual(report.target, target);
  await say.execute("broadcast", { text: "群公告", respondToInputId: "question", receivers: [] }, undefined, undefined, {} as never);
  assert.deepEqual(aide.outputs().find((output) => output.text === "群公告")!.receivers, []);
  await store.say("topic", undefined, "unspecified audience", undefined, { target, inputIds: ["question"] });
  assert.equal(aide.outputs().find((output) => output.text === "unspecified audience")!.receivers, undefined);
  const persisted = new OutputStore(root).get(report.id)!;
  assert.deepEqual(persisted.spec.receivers?.toJSON(), receivers);
  assert.deepEqual(JSON.parse(outputPrinter.describe(persisted).split("Receiver Persons: ")[1]!.split("\n")[0]!), receivers);
  const input = store.inputStore.get("question")!;
  assert.ok(inputPrinter.describe(input).includes(`Source address: ${JSON.stringify(source)}`));
  assert.ok(inputPrinter.describe(input).includes(JSON.stringify(sender)));
  const blocks = topicView(aide, "topic").blocks;
  assert.deepEqual(blocks.find((block) => block.inputId === "question")!.source, source);
  assert.deepEqual(blocks.find((block) => block.id === `message:${report.id}`)!.receivers, receivers);
  assert.deepEqual(store.get("topic")!.pendingInputIds, ["question"]);
  assert.equal(aide.outputs().length, 4, "Two receivers describe one Output; they do not fan out delivery");
});

test("Invalid receivers cannot publish an Output or mutate its Topic; receiver identity is immutable on retry", async (t) => {
  const { aide } = setup(t);
  const { personRef } = await import("../plugins/personal/person/model.ts");
  const { OUTPUT_TYPE } = await import("../plugins/personal/output/model.ts");
  const sender = personRef(await aide.persons.observe({ provider: "web", scope: "local", id: "person" }, "Person"));
  const scope = aide.personal, store = scope.topics;
  const source = webAddress("topic");
  await seedInput(store, "input", { topicId: "topic", origin: "channel", originId: "web", sender, source, text: "request" });
  await scope.plugins.resourceClient("personal").patchStatus(store.resource("topic")!, { execution: { id: "run", startedAt: new Date().toISOString() } });
  for (const bad of [{ ...sender, kind: "Task" }, { ...sender, uid: undefined }]) {
    await assert.rejects(store.say("topic", undefined, "invalid", "run", { target: source, receivers: [bad] }));
    assert.deepEqual(store.outputs("topic"), []);
    assert.equal(aide.outputs().length, 0);
  }
  const options = { respondToInputId: "input", idempotencyKey: "one" };
  const sent = await store.say("topic", undefined, "reply", "run", options);
  await assert.rejects(store.say("topic", undefined, "reply", "run", { ...options, receivers: [] }), /different content/);
  const persisted = await scope.plugins.resourceClient("personal").get({ ...OUTPUT_TYPE, namespace: "v1", name: sent.outputId });
  assert.deepEqual((persisted!.spec as import("../plugins/personal/output/model.ts").OutputSpec).receivers?.toJSON(), [sender]);
  assert.deepEqual(store.outputs("topic").map(o => o.id), [sent.outputId]);
});

/** @case Application admission uses bot configuration, not the Connector's observation address; restart diagnoses stranded Outputs. */
test("Aide rejects unowned targets and diagnoses pending delivery after the Channel is disabled", async t => {
  const { aide, root, options } = setup(t);
  const c = aide.topics;
  await assert.rejects(c.say("default", undefined, "do not queue", undefined,
    { target: larkAddress("connector-app", "observed-chat") }), /No configured Channel/);
  assert.equal(aide.outputs().length, 0);
  const receipt = await c.say("default", undefined, "queued", undefined, { target: larkAddress("app", "bot-chat") });
  assert.deepEqual(receipt, { outputId: receipt.outputId, accepted: true });
  assert.equal(aide.outputStore.get(receipt.outputId)!.status.phase, "pending");
  await aide.close();
  const restarted = new Aide(root, { ...options, config: { ...options.config, channels: {} } }, pino({ level: "silent" }));
  try {
    await restarted.start(); await restarted.settled();
    const output = restarted.outputStore.get(receipt.outputId)!;
    assert.equal(output.status.phase, "delivered");
    assert.equal(output.status.disclosure?.decision, "denied");
    assert.match(output.status.disclosure!.reason, /audience/);
    assert.deepEqual(output.status.delivery?.target, webAddress("default"));
    assert.equal(output.status.attempts, 1, "The same Output records its actual Web delivery attempt");
    await assert.rejects(restarted.topics.say("default", undefined, "still disabled", undefined,
      { target: larkAddress("app", "bot-chat") }), /disabled/);
    assert.equal(restarted.outputs().length, 1);
  } finally { await restarted.close(); }
});

test("Lark names describe exact locations without changing affinity or requiring metadata", () => {
  const input = { appId: "cli_app", chatId: "oc_group" };
  const group = larkTopicLocator.locate({ ...input, chatName: "  DBA\n优化讨论  ", text: "@Me" });
  assert.deepEqual(group, { selector: { kind: "key", key: "lark:cli_app:oc_group" }, name: "DBA 优化讨论" });
  assert.deepEqual(larkTopicLocator.locate({ ...input, chatName: "同群的新名称" }).selector, group.selector);
  assert.deepEqual(larkTopicLocator.locate(input), { selector: group.selector });
  const thread = larkTopicLocator.locate({ ...input, chatName: "DBA 优化讨论", threadId: "omt_thread", text: "OB 查询优化" });
  assert.equal(thread.name, "DBA 优化讨论 · OB 查询优化");
  assert.equal(thread.selector.key, "lark:cli_app:oc_group:thread:omt_thread");
  assert.equal(larkTopicLocator.locate({ ...input, chatName: "李萌", direct: true, threadId: "ignored" }).name, "李萌");
  assert.equal(larkTopicLocator.locate({ ...input, chatName: "x".repeat(1000) }).name!.length, 80);
});
