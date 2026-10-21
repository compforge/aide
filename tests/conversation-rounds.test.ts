import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { fakeOptions, type Agent } from "./fake-harness.ts";
import { appendConversationInput } from "../plugins/personal/conversation/input.ts";

async function setup(t: { after(fn: () => Promise<void>): void }, chief: NonNullable<Agent["chief"]>, policy: object = {}) {
  const root = mkdtempSync(join(tmpdir(), "aide-rounds-"));
  const aide = new Aide(root, { ...fakeOptions({ chief, notify: false, execute: async () => { throw new Error("No work"); } }, root),
    config: ConfigSchema.parse({ plugins: { personal: { conversation: { batchSize: 3, maxWaitSeconds: 30, ...policy } } } }) }, pino({ level: "silent" }));
  const scope = aide.session("me"); await scope.conversations.ensure();
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const submit = (id: string, attention: "immediate" | "deferred" = "deferred") => scope.conversations.submit(id,
    { sessionId: "me", origin: "source", originId: "personal.environments", text: `fact ${id}`, attention });
  return { aide, scope, submit };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(20); }
  assert.ok(check(), "Timed out");
}

test("Deferred inputs batch by count, immediate inputs bypass the threshold, and silent success consumes the whole batch", async (t) => {
  const batches: string[][] = [];
  const { aide, scope, submit } = await setup(t, async (prompt) => {
    batches.push(JSON.parse(prompt.split("Activation: ")[1]!.split("\n")[0]!).inputs.map((i: { inputId: string }) => i.inputId));
    return "Internal: reviewed, no action needed.";
  });
  await submit("1"); await aide.settled(); assert.equal(batches.length, 0);
  await submit("2"); await aide.settled(); assert.equal(batches.length, 0);
  await submit("3"); await aide.settled(); assert.deepEqual(batches, [["1", "2", "3"]]);
  assert.ok(scope.conversations.inputs().every((i) => i.status.phase === "done"));
  assert.equal(aide.messages().length, 0);
  await submit("4"); await aide.settled();
  await submit("urgent", "immediate"); await aide.settled();
  assert.deepEqual(batches[1], ["urgent", "4"]);
});

test("Below-threshold inputs have a deadline and an empty Conversation trigger still reviews work", async (t) => {
  let calls = 0;
  const { aide, scope, submit } = await setup(t, async () => { calls++; return "Review complete"; }, { maxWaitSeconds: 1 });
  await submit("1"); await aide.settled(); assert.equal(calls, 0);
  await until(() => calls === 1); await aide.settled();
  const c = scope.conversations.resource("me")!;
  await scope.plugins.resourceClient("personal").replace(c, { ...c.spec, trigger: { enabled: true, intervalSeconds: 3600 } },
    { ...c.status, nextTriggerAt: new Date(0).toISOString() });
  await aide.settled(); assert.equal(calls, 2); assert.equal(aide.messages().length, 0);
});

test("Summary checkpoints forget only covered inputs, keep concurrent arrivals and prevent redelivery after forgetting", async (t) => {
  let summarizing = false; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(async () => { release(); });
  const { aide, scope, submit } = await setup(t, async (prompt) => {
    if (prompt.startsWith("Compress conversation")) { summarizing = true; await gate; return "The early observations were reviewed; no pending action."; }
    return "Reviewed quietly";
  }, { batchSize: 2, recentInputs: 2 });
  await submit("1"); await submit("2"); await aide.settled();
  await submit("3"); await submit("4"); await until(() => summarizing);
  await submit("5"); release(); await aide.settled();
  const c = scope.conversations.resource("me")!;
  assert.deepEqual(c.spec.inputIds, ["3", "4", "5"]);
  assert.match(c.status.summary!.text, /early observations/);
  const fact = scope.conversations.inputStore.get("1")!;
  assert.equal(await appendConversationInput(scope.plugins.resourceClient("personal"),
    { sessionId: "me", name: c.metadata.name, uid: c.metadata.uid }, fact), false);
  assert.deepEqual(scope.conversations.resource("me")!.spec.inputIds, ["3", "4", "5"]);
  assert.equal(aide.messages().length, 0);
});

test("A failed summary retains history and blocks deferred executions without per-input warnings", async (t) => {
  let calls = 0;
  const { aide, scope, submit } = await setup(t, async (prompt) => {
    calls++;
    if (prompt.startsWith("Compress conversation")) throw new Error("summary unavailable");
    return "No action needed";
  }, { batchSize: 2, recentInputs: 2 });
  for (const id of ["1", "2", "3", "4"]) { await submit(id); await aide.settled(); }
  assert.ok(scope.conversations.resource("me")!.status.blocked);
  assert.equal(scope.conversations.get("me")!.inputIds.length, 4);
  const before = calls;
  await submit("5"); await submit("6"); await aide.settled();
  assert.equal(calls, before); assert.equal(aide.messages().length, 0);
  assert.equal(scope.conversations.input("5")!.status.phase, undefined);
});

test("Large round results drain through bounded summaries before another batch can grow history", async (t) => {
  let summaries = 0;
  const { aide, scope, submit } = await setup(t, async (prompt) => {
    if (prompt.startsWith("Compress conversation")) { summaries++; return "Reviewed earlier facts."; }
    return "x".repeat(1000);
  }, { batchSize: 3, recentInputs: 1, contextChars: 4096, summaryChars: 1000 });
  for (let i = 0; i < 9; i++) await submit(String(i));
  await until(() => scope.conversations.inputs().every((i) => i.status.phase === "done") && scope.conversations.get("me")!.inputIds.length < 4);
  await aide.settled();
  assert.ok(summaries >= 3);
  assert.equal(scope.conversations.resource("me")!.status.blocked, undefined);
});
