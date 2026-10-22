import { fixtureIncoming } from "./address-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";

const log = pino({ level: "silent" });

test("Chief accepts duplicate input once, answers without Work, isolates conversations and never replays a failed turn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-chief-"));
  const prompts: string[] = [];
  let calls = 0;
  const options = fakeOptions({ chief: async (prompt) => {
    calls++;
    const activation = JSON.parse(prompt.split("Activation: ")[1]!.split("\n")[0]!);
    if (activation.inputs[0].description.endsWith("\n\nText:\nfail")) throw new Error("Disconnected");
    return "直接回答";
  },
    execute: async () => { throw new Error("Unexpected Work"); } }, root, prompts);
  let aide = new Aide(root, options, log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const input = { channelId: "web", id: "one", sessionId: "me", conversationId: "me", text: "private-information" };
  const [first, duplicate] = await Promise.all([aide.receive(fixtureIncoming(input)), aide.receive(fixtureIncoming(input))]);
  assert.deepEqual(first, duplicate);
  await aide.settled();
  assert.equal(calls, 1);
  assert.equal(aide.session("me").conversations.resource("me")!.status.batch?.phase, "done", JSON.stringify(aide.session("me").conversations.resource("me")!.status.batch));
  assert.equal(aide.works().length, 0);
  assert.deepEqual(aide.outputs().map((m) => m.text), ["直接回答"]);
  await aide.receive(fixtureIncoming({ ...input, sessionId: "other", conversationId: "other", text: "hello" })); await aide.settled();
  assert.doesNotMatch(prompts[1]!, /private-information/);
  await aide.receive(fixtureIncoming({ ...input, id: "failed", text: "fail" })); await aide.settled();
  assert.match(aide.outputs().at(-1)!.text, /本次处理未完成/);
  await aide.close(); aide = new Aide(root, options, log); await aide.start();
  await aide.receive(fixtureIncoming({ ...input, id: "failed", text: "fail" })); await aide.settled();
  assert.equal(calls, 3);
  assert.equal(aide.works().length, 0);
});
