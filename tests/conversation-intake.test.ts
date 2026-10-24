import { Background as ConversationBackground } from "../plugins/personal/conversation/background.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { fixtureIncoming } from "./address-fixture.ts";
import { routeTo } from "./input-state-fixture.ts";
import { chiefTools } from "../agents/chief/chief-tools.ts";
import { emptyConnectors } from "../src/connector-client.ts";

/** @case Pending references do not impose a per-Conversation admission limit, regardless of producer. */
test("Channel and Source Inputs share idempotent admission beyond the old pending limit", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-intake-"));
  const aide = new Aide(home, fakeOptions({ execute: async () => { throw new Error("No work"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const scope = aide.personal, conversation = await scope.conversations.ensure("topic");
  const client = scope.plugins.resourceClient("personal");
  const target = { name: conversation.metadata.name, uid: conversation.metadata.uid };
  for (let i = 0; i < 125; i++) {
    const input = await scope.conversations.submit(`input-${i}`, { origin: i % 2 ? "channel" : "source", originId: i % 2 ? "web" : "personal.environments", text: `fact ${i}` });
    assert.equal(await routeTo(client, target, input), true);
    assert.equal(await routeTo(client, target, input), false);
  }
  assert.equal(scope.conversations.get("topic")!.pendingInputIds.length, 125);
  assert.equal(new Set(scope.conversations.get("topic")!.pendingInputIds).size, 125);
  assert.equal(!!scope.conversations.inputStore.get("input-124")!.status.assess?.[conversation.metadata.uid], true);
});

test("A say request for information finishes processing; the answer is a new Input in the same context", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-followup-"));
  const prompts: string[] = [];
  let calls = 0;
  const options = fakeOptions({ chief: async () => ++calls === 1 ? "请提供目标环境。" : "收到，处理 test 环境。", execute: async () => { throw new Error("No work"); } }, home, prompts);
  let aide = new Aide(home, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const first = fixtureIncoming({ channelId: "web", id: "first", sessionId: "me", text: "检查环境" });
  await aide.receive(first); await aide.settled();
  const before = aide.invocations().at(-1)!;
  assert.deepEqual(aide.personal.conversations.get("me")!.pendingInputIds, []);
  assert.equal(aide.outputs().at(-1)!.text, "请提供目标环境。");
  assert.equal(aide.personal.core.executions.approvals().length, 0);
  await aide.close();
  aide = new Aide(home, options, pino({ level: "silent" }));
  assert.match(new ConversationBackground(aide.personal.store, aide.conversations.resource("me"), "me").text(), /请提供目标环境。/);
  await aide.receive(fixtureIncoming({ channelId: "web", id: "answer", sessionId: "me", text: "test 环境" })); await aide.settled();
  const after = aide.invocations().at(-1)!;
  assert.notEqual(after.invocationId, before.invocationId);
  assert.deepEqual(aide.personal.conversations.get("me")!.pendingInputIds, []);
  const material = JSON.parse(prompts.at(-1)!.split("Activation: ")[1]!.split("\n")[0]!);
  assert.equal(material.summary, undefined, "Current understanding is supplied by the context projection, not copied into each Input");
  assert.equal(material.inputs.length, 1, "Only the new Input is replayed; prior understanding is bounded context");
  assert.match(prompts.at(-1)!, /test 环境/);
  await aide.receive(first); await aide.settled();
  assert.equal(calls, 2);
  const names = chiefTools(emptyConnectors).map((tool) => tool.name);
  assert.ok(names.includes("say"));
  assert.equal(names.includes("ask"), false); assert.equal(names.includes("confirm"), false);
});
