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
  const root = mkdtempSync(join(tmpdir(), "aide-batches-"));
  const aide = new Aide(root, { ...fakeOptions({ chief, notify, execute: async () => { throw new Error("No work"); } }, root),
    config: ConfigSchema.parse({ plugins: { personal: { conversation: { batchSize: 3, maxWaitSeconds: 30, ...policy } } } }) }, pino({ level: "silent" }));
  const scope = aide.session("me"); await scope.conversations.ensure();
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const submit = (id: string, attention: "immediate" | "deferred" = "deferred") => scope.conversations.submit(id,
    { sessionId: "me", origin: "source", originId: "personal.environments", text: `fact ${id}`, attention });
  await aide.start();
  return { aide, scope, submit };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(20); }
  assert.ok(check(), "Timed out");
}

test("Count and urgency create stable Batches; only acknowledged members leave the pending queue", async (t) => {
  const batches: string[][] = [];
  const { aide, scope, submit } = await setup(t, async (prompt) => {
    batches.push(JSON.parse(prompt.split("Activation: ")[1]!.split("\n")[0]!).inputs.map((i: { inputId: string }) => i.inputId));
    return "Reviewed quietly";
  });
  await submit("1"); await aide.settled(); assert.equal(batches.length, 0);
  await submit("2"); await aide.settled(); assert.equal(batches.length, 0);
  await submit("3"); await aide.settled(); assert.deepEqual(batches, [["1", "2", "3"]]);
  const first = scope.conversations.resource("me")!;
  assert.deepEqual(first.status.pendingInputIds, []);
  assert.equal(first.status.batch!.phase, "done");
  assert.deepEqual(first.status.batch!.inputIds, ["1", "2", "3"]);
  await submit("4"); await aide.settled();
  assert.equal(scope.conversations.resource("me")!.status.batch!.id, first.status.batch!.id);
  await submit("urgent", "immediate"); await aide.settled();
  const next = scope.conversations.resource("me")!;
  assert.deepEqual(batches[1], ["urgent", "4"]);
  assert.notEqual(next.status.batch!.id, first.status.batch!.id);
  assert.match(next.status.batch!.context.history, /fact 1/);
  assert.deepEqual(next.status.pendingInputIds, []);
  assert.equal(aide.messages().length, 0);
  assert.equal(await appendConversationInput(scope.plugins.resourceClient("personal"),
    { sessionId: "me", name: next.metadata.name, uid: next.metadata.uid }, scope.conversations.inputStore.get("1")!), false);
  assert.deepEqual(scope.conversations.resource("me")!.status.pendingInputIds, []);
});

test("A deferred append leaves the running Batch snapshot unchanged and survives acknowledgement", async (t) => {
  let entered = false; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => { release(); });
  const { aide, scope, submit } = await setup(t, async () => { entered = true; await gate; return "Reviewed"; });
  await submit("first", "immediate"); await until(() => entered);
  const before = scope.conversations.resource("me")!.status.batch!;
  await submit("later");
  await until(() => scope.conversations.resource("me")!.status.pendingInputIds.includes("later"));
  const during = scope.conversations.resource("me")!.status.batch!;
  assert.deepEqual(during.context, before.context); assert.deepEqual(during.inputIds, ["first"]);
  release(); await aide.settled();
  assert.deepEqual(scope.conversations.resource("me")!.status.pendingInputIds, ["later"]);
});

test("Below-threshold input has a deadline and an empty trigger still creates a Batch", async (t) => {
  let calls = 0;
  const { aide, scope, submit } = await setup(t, async () => { calls++; return "Review complete"; }, { maxWaitSeconds: 1 });
  await submit("1"); await aide.settled(); assert.equal(calls, 0);
  await until(() => calls === 1); await aide.settled();
  const c = scope.conversations.resource("me")!;
  await scope.plugins.resourceClient("personal").replace(c, { ...c.spec, trigger: { enabled: true, intervalSeconds: 3600 } },
    { ...c.status, nextTriggerAt: new Date(0).toISOString() });
  await aide.settled(); assert.equal(calls, 2);
  assert.deepEqual(scope.conversations.resource("me")!.status.batch!.inputIds, []);
});

test("Immediate input interrupts the old execution and transfers its uncertain effects without blind replay", async (t) => {
  const batches: string[][] = []; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => { release(); });
  const { aide, scope, submit } = await setup(t, async (prompt) => {
    batches.push(JSON.parse(prompt.split("Activation: ")[1]!.split("\n")[0]!).inputs.map((i: { inputId: string }) => i.inputId));
    if (batches.length === 1) await gate;
    else assert.match(prompt, /Previously attempted; verify effects/);
    return "Reviewed";
  }, { batchSize: 1 });
  await submit("old"); await until(() => batches.length === 1);
  await submit("urgent", "immediate"); await until(() => batches.length === 2);
  assert.deepEqual(batches, [["old"], ["urgent", "old"]]);
  release(); await aide.settled();
  assert.deepEqual(scope.conversations.resource("me")!.status.pendingInputIds, []);
});

test("Oversized facts are compacted in complete bounded fragments before consumption", async (t) => {
  const fragments: string[] = []; let checkpointSeen = false;
  const { aide, scope } = await setup(t, async (prompt) => {
    if (prompt.startsWith("Compress conversation")) {
      assert.ok(prompt.length <= 4096);
      fragments.push(prompt.split("History:\n")[1]!);
      if (fragments.length === 2) {
        const c = scope.conversations.resource("me")!;
        assert.ok(c.status.batch!.compaction!.offset > 0);
        assert.ok(c.status.pendingInputIds.includes("large"));
        checkpointSeen = true;
      }
      return prompt.includes("TAIL_EVIDENCE") ? "Retained TAIL_EVIDENCE" : "Earlier part retained";
    }
    return "Reviewed";
  }, { batchSize: 1, contextChars: 4096, summaryChars: 1000 });
  await scope.conversations.submit("large", { sessionId: "me", origin: "source", originId: "personal.environments", text: "x".repeat(8000) + "TAIL_EVIDENCE" });
  await aide.settled();
  const c = scope.conversations.resource("me")!;
  assert.ok(checkpointSeen); assert.equal(c.status.batch!.compaction, undefined);
  assert.deepEqual(c.status.pendingInputIds, []); assert.match(c.status.batch!.result!.context!, /TAIL_EVIDENCE/);
  const joined = fragments.map((s) => s.slice(s.indexOf("\n") + 1)).join("");
  assert.match(joined, /x{8000}TAIL_EVIDENCE/);
});

test("Failed Batch retains pending inputs, does not replay, and a full queue reserves one immediate recovery slot", async (t) => {
  let fail = true; let calls = 0;
  const { aide, scope, submit } = await setup(t, async () => { calls++; if (fail) throw new Error("Unavailable"); return "Reviewed"; }, { batchSize: 1, maxPending: 2 }, true);
  await submit("failed"); await aide.settled();
  await submit("deferred"); await aide.settled();
  assert.equal(calls, 1);
  const c = scope.conversations.resource("me")!;
  assert.equal(c.status.batch!.phase, "failed"); assert.deepEqual(c.status.pendingInputIds, ["failed", "deferred"]);
  const immediate = { origin: "channel" as const, originId: "web", text: "recover" };
  assertInputCapacity(c, immediate, 2);
  assert.throws(() => assertInputCapacity({ ...c, status: { ...c.status, pendingInputIds: [...c.status.pendingInputIds, "reserved"] } }, immediate, 2), /capacity exhausted/);
  assert.throws(() => assertInputCapacity(c, { ...immediate, attention: "deferred" }, 2), /capacity exhausted/);
  fail = false;
  await aide.receive({ id: "recover", channelId: "web", sessionId: "me", text: "Verify and continue" });
  await aide.settled();
  assert.equal(scope.conversations.resource("me")!.status.batch!.phase, "done");
  assert.deepEqual(scope.conversations.resource("me")!.status.pendingInputIds, []);
});

test("A failed pure compaction resumes its checkpoint after restart without repeating action execution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-summary-resume-"));
  let summaryCalls = 0, actionCalls = 0, fail = true;
  const fragments: string[] = [];
  const options = { ...fakeOptions({ notify: false, async chief(prompt) {
    if (prompt.startsWith("Compress conversation")) {
      summaryCalls++;
      if (fail && summaryCalls === 2) throw new Error("summary interrupted");
      fragments.push(prompt.split("History:\n")[1]!); return "Checkpoint";
    }
    actionCalls++; return "Reviewed";
  }, async execute() { throw new Error("No work"); } }, root),
    config: ConfigSchema.parse({ plugins: { personal: { conversation: { batchSize: 1, contextChars: 4096, summaryChars: 1000 } } } }) };
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  let scope = aide.session("me"); await scope.conversations.ensure();
  await scope.conversations.submit("large", { sessionId: "me", origin: "source", originId: "personal.environments", text: "x".repeat(7000) });
  await aide.settled();
  const offset = scope.conversations.resource("me")!.status.batch!.compaction!.offset;
  assert.ok(offset > 0); assert.equal(actionCalls, 1);
  await aide.close(); fail = false;
  aide = new Aide(root, options, pino({ level: "silent" })); await aide.start(); scope = aide.session("me");
  await scope.conversations.submit("resume", { sessionId: "me", origin: "source", originId: "personal.environments", text: "resume", attention: "immediate" });
  await aide.settled();
  assert.match(fragments[1]!, new RegExp(`characters ${offset}\\.\\.`));
  assert.equal(actionCalls, 2, "Only the new request may execute actions after recovery");
  assert.deepEqual(scope.conversations.resource("me")!.status.pendingInputIds, []);
});
