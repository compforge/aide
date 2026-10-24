import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { assessInput } from "../plugins/personal/conversation/assess.ts";
import { deliver } from "../plugins/personal/route/delivery.ts";
import { admit } from "./input-state-fixture.ts";
import { cancelAssignments, resourceRef } from "../plugins/personal/input/state.ts";
import { InputDefinition } from "../plugins/personal/input/definition.ts";
import { INPUT_TYPE } from "../plugins/personal/input/model.ts";
import { ResourceStorageConfigSchema } from "../src/host/resource/storage.ts";
function setup(t: { after(fn: () => Promise<void>): void }) {
  const home = mkdtempSync(join(tmpdir(), "aide-assess-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected execution"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  return { aide, resources, context: { resources, logger: { info() {} } } };
}
const task = { kind: "task" as const, title: "Check", instruction: "Verify evidence", trigger: null };

test("Concurrent Chief assessments preserve each other and atomically establish independent Work handling", async t => {
  const { aide, resources, context } = setup(t);
  const a = await aide.conversations.ensure("a"), b = await aide.conversations.ensure("b");
  const wa = await aide.work("a").create(task), wb = await aide.work("b").create(task);
  const input = await aide.conversations.submit("fact", { origin: "source", originId: "fixture", text: "shared evidence" });
  await deliver(context, input, [a.metadata, b.metadata], "Both topics");
  for (const c of [a, b]) {
    await resources.patchStatus(aide.conversations.resource(c.spec.id)!, { execution: { id: c.spec.id, startedAt: new Date().toISOString() } });
    await admit(resources, "fact", c.metadata.uid, c.spec.id);
  }
  await Promise.all([[a, wa], [b, wb]].map(async ([owner, work]) => {
    const c = owner as typeof a, w = work as typeof wa;
    await assessInput(resources, c, c.spec.id, { inputId: "fact", summary: `Assessed by ${c.spec.id}`, workRequests: [{ workUid: w.uid!, request: { action: "context" } }] });
  }));
  const result = aide.conversations.inputStore.get("fact")!;
  assert.ok(result.status.assess![a.metadata.uid]!.completedAt);
  assert.ok(result.status.assess![b.metadata.uid]!.completedAt);
  assert.deepEqual(Object.keys(result.status.handle!).sort(), [wa.uid!, wb.uid!].sort());
  assert.equal(InputDefinition.retention!.releasedAt(result), undefined);
  assert.deepEqual(aide.conversations.pending(a.metadata.uid), []);
  assert.equal("pendingInputIds" in aide.conversations.resource("a")!.status, false);
  await assessInput(resources, a, "a", { inputId: "fact", summary: "repeat" });
  assert.deepEqual(aide.conversations.inputStore.get("fact"), result);
});

test("Failed handoff rolls back assessment, Work assignments and summary; foreign Work cannot be assigned", async t => {
  const { aide, resources, context } = setup(t);
  const c = await aide.conversations.ensure("me");
  const w = await aide.work("me").create(task), foreign = await aide.work("other").create(task);
  const input = await aide.conversations.submit("fact", { origin: "channel", originId: "web", text: "please check" });
  await deliver(context, input, [c.metadata], "topic");
  await resources.patchStatus(aide.conversations.resource("me")!, { execution: { id: "live", startedAt: new Date().toISOString() } });
  await admit(resources, "fact", c.metadata.uid, "live");
  const before = aide.conversations.inputStore.get("fact")!;
  const handlesBefore = aide.conversations.inputStore.query("handlePending", w.uid!);
  const conversationBefore = aide.conversations.resource("me")!.status;
  await assert.rejects(assessInput(resources, c, "live", { inputId: "fact", summary: "bad", workRequests: [{ workUid: foreign.uid!, request: {} }] }), /Work unavailable/);
  const failing = { ...resources, commit: (writes: Parameters<typeof resources.commit>[0]) => resources.commit([...writes,
    { operation: "create", type: { ...INPUT_TYPE, kind: "Unregistered" }, name: "failure", spec: {}, status: {} }]) };
  await assert.rejects(assessInput(failing, c, "live", { inputId: "fact", summary: "handoff", workRequests: [{ workUid: w.uid!, request: {} }] }), /Unknown resource/);
  assert.deepEqual(aide.conversations.inputStore.get("fact"), before);
  assert.deepEqual(aide.conversations.resource("me")!.status, conversationBefore);
  assert.deepEqual(aide.conversations.inputStore.query("handlePending", w.uid!), handlesBefore);
});

test("Input protects every unfinished stage; deleting its Work ends handling and permits quota eviction", async t => {
  const { aide, resources, context } = setup(t);
  const c = await aide.conversations.ensure("me");
  const w = await aide.work("me").create(task);
  const store = aide.conversations.inputStore;
  const initialTask = (await resources.list({ ...INPUT_TYPE, kind: "Task" }))[0]!;
  await cancelAssignments(resources, resourceRef(initialTask), "handle");
  store.storage.configure(ResourceStorageConfigSchema.parse({ kinds: { "aide.dev/Input": { maxCount: 1 } } }));
  const input = await aide.conversations.submit("one", { origin: "source", originId: "fixture", text: "fact" });
  await deliver(context, input, [c.metadata], "topic");
  const second = () => aide.conversations.submit("two", { origin: "source", originId: "fixture", text: "another" });
  await assert.rejects(second(), /capacity/);
  await resources.patchStatus(aide.conversations.resource("me")!, { execution: { id: "live", startedAt: new Date().toISOString() } });
  await admit(resources, "one", c.metadata.uid, "live");
  await assessInput(resources, c, "live", { inputId: "one", summary: "Delegated", workRequests: [{ workUid: w.uid!, request: {} }] });
  await assert.rejects(second(), /capacity/);
  const target = (await resources.list({ apiVersion: INPUT_TYPE.apiVersion, kind: "Task" }))[0]!;
  await resources.delete(target, target.metadata.name);
  await cancelAssignments(resources, resourceRef(target), "handle");
  assert.equal(store.get("one")!.status.handle![w.uid!]!.result!.disposition, "cancelled");
  await second();
  assert.equal(store.get("one"), undefined);
  assert.deepEqual(store.query("assess", c.metadata.uid), []);
  assert.ok(store.receipt("one"));
});

test("Conversation review replaces cumulative understanding, bounds recent and rejects stale synthesis", async t => {
  const { summarizeConversation } = await import("../plugins/personal/conversation/state.ts");
  const { aide, resources } = setup(t);
  await aide.conversations.ensure("me");
  await resources.patchStatus(aide.conversations.resource("me")!, { execution: { id: "review", startedAt: new Date().toISOString() } });
  const stale = aide.conversations.resource("me")!;
  for (let n = 0; n < 55; n++) {
    const c = aide.conversations.resource("me")!;
    await summarizeConversation(resources, c, "review", { version: c.metadata.resourceVersion,
      summary: `Current understanding ${n}`, recent: `Review ${n}: ${"e".repeat(2000)}` }, 4000);
  }
  const current = aide.conversations.resource("me")!;
  assert.equal(current.status.summary, "Current understanding 54");
  assert.ok(current.status.recent.length <= 40);
  assert.ok(current.status.recent.reduce((sum, entry) => sum + entry.text.length, 0) <= 16000);
  await assert.rejects(summarizeConversation(resources, stale, "review", { version: stale.metadata.resourceVersion, summary: "stale", recent: "stale" }, 4000), /changed/);
  await assert.rejects(summarizeConversation(resources, current, "wrong-execution", { version: current.metadata.resourceVersion, summary: "stale", recent: "stale" }, 4000), /no longer active/);
  await assert.rejects(summarizeConversation(resources, current, "review", { version: current.metadata.resourceVersion, summary: "x".repeat(4001), recent: "oversize" }, 4000), /exceeds/);
  assert.deepEqual(aide.conversations.resource("me")!.status, current.status);
});

/** @case Repeated silent receipts do not evict important context or imply an unresolved anomaly recovered. */
test("quiet assessments retain topic understanding; explicit synthesis can update summary without recent", async t => {
  const { summarizeConversation } = await import("../plugins/personal/conversation/state.ts");
  const { aide, resources, context } = setup(t);
  const c = await aide.conversations.ensure("me");
  const recent = [{ at: new Date().toISOString(), text: "User asked to investigate recurrent OOM" }];
  await resources.patchStatus(c, { execution: { id: "live", startedAt: new Date().toISOString() }, summary: "OOM unresolved; investigation delegated", recent });
  for (let i = 0; i < 45; i++) {
    const fact = await aide.conversations.submit(`quiet-${i}`, { origin: "source", originId: "fixture", text: "same-image Pod churn" });
    await deliver(context, fact, [c.metadata], "same subject");
    await admit(resources, fact.metadata.name, c.metadata.uid, "live");
    await assessInput(resources, c, "live", { inputId: fact.metadata.name, summary: "No new action" });
    assert.ok(aide.conversations.inputStore.get(fact.metadata.name)!.status.assess![c.metadata.uid]!.completedAt);
  }
  const current = aide.conversations.resource("me")!;
  assert.equal(current.status.summary, "OOM unresolved; investigation delegated");
  assert.deepEqual(current.status.recent, recent);
  const receipt = await summarizeConversation(resources, current, "live", { version: current.metadata.resourceVersion, summary: "OOM cause confirmed; fix pending" }, 4000);
  assert.deepEqual(Object.keys(receipt), ["version"], "Do not echo all context back into model history");
  assert.deepEqual(aide.conversations.resource("me")!.status.recent, recent);
  assert.equal(aide.conversations.resource("me")!.status.summary, "OOM cause confirmed; fix pending");
});

test("assessment cannot complete across an execution switch during its commit", async t => {
  const { aide, resources, context } = setup(t);
  const c = await aide.conversations.ensure("me");
  const fact = await aide.conversations.submit("switch", { origin: "source", originId: "fixture", text: "observation" });
  await deliver(context, fact, [c.metadata], "topic");
  await resources.patchStatus(aide.conversations.resource("me")!, { execution: { id: "old", startedAt: new Date().toISOString() } });
  await admit(resources, "switch", c.metadata.uid, "old");
  let switched = false;
  const racing = { ...resources, commit: async (writes: Parameters<typeof resources.commit>[0]) => {
    if (!switched) { switched = true; await resources.patchStatus(aide.conversations.resource("me")!, { execution: { id: "new", startedAt: new Date().toISOString() } }); }
    return resources.commit(writes);
  } };
  await assert.rejects(assessInput(racing, c, "old", { inputId: "switch", summary: "quiet" }), /no longer active/);
  assert.equal(aide.conversations.inputStore.get("switch")!.status.assess![c.metadata.uid]!.completedAt, undefined);
});
