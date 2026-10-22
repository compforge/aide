import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions, type Agent } from "./fake-harness.ts";
import { completeInputs } from "../plugins/personal/conversation/complete.ts";
import { appendConversationInput } from "../plugins/personal/conversation/input.ts";
import { processing } from "../plugins/personal/loop.ts";

function setup(t: { after(fn: () => Promise<void>): void }, agent: Partial<Agent> = {}) {
  const root = mkdtempSync(join(tmpdir(), "aide-continuous-"));
  const options = fakeOptions({ notify: false, async execute() { throw new Error("No work"); }, ...agent }, root);
  const aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const submit = (id: string, attention: "immediate" | "deferred" = "deferred") => aide.conversations.submit(id,
    { sessionId: "me", origin: "source", originId: "personal.environments", text: `fact ${id}`, attention });
  return { aide, submit, root, options };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(20); }
  assert.ok(check(), "Timed out");
}

test("Completion atomically acknowledges only admitted inputs; redelivery and repeated completion are idempotent", async t => {
  const { aide, submit } = setup(t);
  const c = await aide.conversations.ensure("me");
  const client = aide.runtime.plugins.resourceClient("personal");
  for (const id of ["one", "later"]) await appendConversationInput(client, c.metadata, await submit(id));
  await client.patchStatus(aide.conversations.resource("me")!, { execution: { id: "live", startedAt: new Date().toISOString() } });
  await processing(client, "one", c.metadata.uid, () => ({ executionId: "live", phase: "submitted", at: new Date().toISOString() }));
  await assert.rejects(completeInputs(client, c, "live", { inputIds: ["one", "later"], summary: "invalid" }), /not been admitted/);
  assert.deepEqual(aide.conversations.resource("me")!.status.pendingInputIds, ["one", "later"]);
  await completeInputs(client, c, "live", { inputIds: ["one"], summary: "Nothing needs action" });
  await completeInputs(client, c, "live", { inputIds: ["one"], summary: "Nothing needs action" });
  assert.deepEqual(aide.conversations.resource("me")!.status.pendingInputIds, ["later"]);
  assert.equal(await appendConversationInput(client, c.metadata, aide.conversations.inputStore.get("one")!), false);
  assert.equal(aide.outputs().length, 0);
  assert.equal(aide.conversations.resource("me")!.status.summary, "Nothing needs action");
  await assert.rejects(completeInputs(client, c, "old", { inputIds: ["one"], summary: "stale" }), /no longer active/);
});

test("Deferred arrivals follow up without repeating old prompt material or deleting concurrent arrivals", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const { aide, submit } = setup(t, { async chief(prompt) { calls.push(prompt); if (calls.length === 1) await gate; return "Handled"; } });
  t.after(() => release());
  await aide.conversations.ensure("me"); await aide.start();
  await submit("first"); await until(() => calls.length === 1);
  await submit("later"); await until(() => aide.conversations.resource("me")!.status.pendingInputIds.includes("later"));
  assert.equal(calls.length, 1);
  release(); await aide.settled();
  assert.equal(calls.length, 2); assert.doesNotMatch(calls[1]!, /fact first/);
  assert.deepEqual(aide.conversations.resource("me")!.status.pendingInputIds, []);
  assert.equal(aide.invocations().filter(i => i.conversationId === "me").every(i => !i.freshContext), true);
});

test("Model end_turn without complete_inputs retains an explicit failure and never silently retries effects", async t => {
  let calls = 0;
  const { aide, submit, root, options } = setup(t, { complete: false, async chief() { calls++; return "I handled it"; } });
  await aide.conversations.ensure("me"); await aide.start(); await submit("unacknowledged"); await aide.settled();
  assert.equal(calls, 1); assert.equal(aide.conversations.input("unacknowledged", "me")!.consumption.phase, "failed");
  await aide.close();
  const restarted = new Aide(root, options, pino({ level: "silent" }));
  try { await restarted.start(); await restarted.settled(); assert.equal(calls, 1); }
  finally { await restarted.close(); }
});

test("An unsupported steer leaves the urgent input queued for explicit followup without cancelling current work", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const { aide, submit } = setup(t, { async chief() { calls++; if (calls === 1) await gate; return "Handled"; } });
  t.after(() => release());
  await aide.conversations.ensure("me"); await aide.start(); await submit("first"); await until(() => calls === 1);
  await submit("urgent", "immediate"); await until(() => aide.conversations.resource("me")!.status.pendingInputIds.includes("urgent"));
  assert.equal(calls, 1); release(); await aide.settled(); assert.equal(calls, 2);
  assert.deepEqual(aide.conversations.resource("me")!.status.pendingInputIds, []);
});
