import { assertInputCapacity } from "../plugins/personal/conversation/input.ts";
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

async function setup(t: { after(fn: () => Promise<void>): void }, chief: NonNullable<Agent["chief"]>, policy: object = {}, notify = false) {
  const root = mkdtempSync(join(tmpdir(), "aide-rounds-"));
  const aide = new Aide(root, { ...fakeOptions({ chief, notify, execute: async () => { throw new Error("No work"); } }, root),
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

test("Oversized history is checkpointed without truncation, then urgent work still runs", async (t) => {
  const fragments: string[] = []; let checkpointSeen = false;
  const { aide, scope } = await setup(t, async (prompt) => {
    if (prompt.startsWith("Compress conversation")) {
      assert.ok(prompt.length <= 4096, "Summary invocation stays inside the material budget");
      const fragment = prompt.split("History:\n")[1]!;
      fragments.push(fragment);
      if (fragments.length === 2) {
        const c = scope.conversations.resource("me")!;
        assert.ok(c.status.compaction!.offset > 0);
        assert.ok(c.spec.inputIds.includes("large"), "Partial summaries must retain the original fact");
        checkpointSeen = true;
      }
      return prompt.includes("TAIL_EVIDENCE") ? "Retained TAIL_EVIDENCE" : "Earlier part retained";
    }
    return "Reviewed";
  }, { batchSize: 1, recentInputs: 1, contextChars: 4096, summaryChars: 1000 });
  await scope.conversations.submit("large", { sessionId: "me", origin: "source", originId: "personal.environments", text: "x".repeat(8000) + "TAIL_EVIDENCE" });
  await aide.settled();
  await scope.conversations.submit("next", { sessionId: "me", origin: "source", originId: "personal.environments", text: "next" });
  await until(() => !!scope.conversations.resource("me")!.status.summary);
  await aide.settled();
  const c = scope.conversations.resource("me")!;
  assert.ok(checkpointSeen); assert.equal(c.status.compaction, null);
  assert.ok(!c.spec.inputIds.includes("large")); assert.match(c.status.summary!.text, /TAIL_EVIDENCE/);
  const joined = fragments.map((s) => s.slice(s.indexOf("\n") + 1)).join("");
  assert.match(joined, /x{8000}TAIL_EVIDENCE/);
  await scope.conversations.submit("urgent", { sessionId: "me", origin: "source", originId: "personal.environments", text: "urgent", attention: "immediate" });
  await aide.settled(); assert.equal(scope.conversations.input("urgent")!.status.phase, "done");
  assert.ok(!scope.conversations.resource("me")!.status.blocked);
});

test("A full blocked deferred queue admits exactly one recovery input and consumes it first", async (t) => {
  let fail = true; const batches: string[][] = [];
  const { aide, scope, submit } = await setup(t, async (prompt) => {
    if (fail) throw new Error("Model unavailable");
    batches.push(JSON.parse(prompt.split("Activation: ")[1]!.split("\n")[0]!).inputs.map((i: { inputId: string }) => i.inputId));
    return "Reviewed";
  }, { batchSize: 1, maxPending: 2 }, true);
  await submit("failed"); await aide.settled();
  await submit("one"); await submit("two"); await aide.settled();
  const c = scope.conversations.resource("me")!;
  assert.ok(c.status.blocked);
  const immediate = { origin: "channel" as const, originId: "web", text: "recover" };
  assertInputCapacity(c, immediate, 2);
  assert.throws(() => assertInputCapacity({ ...c, spec: { ...c.spec, inputIds: [...c.spec.inputIds, "reserved"] } }, immediate, 2), /capacity exhausted/);
  assert.throws(() => assertInputCapacity(c, { ...immediate, attention: "deferred" }, 2), /capacity exhausted/);
  fail = false;
  const accepted = await aide.receive({ id: "resume", channelId: "web", sessionId: "me", text: "continue" });
  await aide.settled();
  assert.equal(batches[0]![0], accepted.inputId);
  assert.equal(scope.conversations.input("one")!.status.phase, "done");
  assert.equal(scope.conversations.input("two")!.status.phase, "done");
  assert.ok(!scope.conversations.resource("me")!.status.blocked);
});

test("A partial history summary survives failure and restart without replaying covered fragments", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-summary-resume-"));
  let summaryCalls = 0, fail = true;
  const fragments: string[] = [];
  const options = { ...fakeOptions({ notify: false, async chief(prompt) {
    if (prompt.startsWith("Compress conversation")) {
      summaryCalls++;
      if (fail && summaryCalls === 2) throw new Error("summary interrupted");
      fragments.push(prompt.split("History:\n")[1]!);
      return "Checkpoint";
    }
    return "Reviewed";
  }, async execute() { throw new Error("No work"); } }, root),
    config: ConfigSchema.parse({ plugins: { personal: { conversation: { batchSize: 1, recentInputs: 1, contextChars: 4096, summaryChars: 1000 } } } }) };
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  let scope = aide.session("me"); await scope.conversations.ensure();
  for (const [id, text] of [["large", "x".repeat(7000)], ["next", "next"]]) {
    await scope.conversations.submit(id!, { sessionId: "me", origin: "source", originId: "personal.environments", text: text! });
    await aide.settled();
  }
  await until(() => !!scope.conversations.resource("me")!.status.blocked);
  const offset = scope.conversations.resource("me")!.status.compaction!.offset;
  assert.ok(offset > 0); assert.ok(scope.conversations.resource("me")!.spec.inputIds.includes("large"));
  await aide.close(); fail = false;
  aide = new Aide(root, options, pino({ level: "silent" })); await aide.start(); scope = aide.session("me");
  await scope.conversations.submit("resume", { sessionId: "me", origin: "source", originId: "personal.environments", text: "resume", attention: "immediate" });
  await until(() => !scope.conversations.resource("me")!.spec.inputIds.includes("large"));
  await aide.settled();
  assert.match(fragments[1]!, new RegExp(`characters ${offset}\\.\\.`));
  assert.equal(scope.conversations.input("resume")!.status.phase, "done");
  assert.ok(!scope.conversations.resource("me")!.status.compaction);
});
