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
  await assert.rejects(assessInput(resources, c, "live", { inputId: "fact", summary: "bad", workRequests: [{ workUid: foreign.uid!, request: {} }] }), /Work unavailable/);
  const failing = { ...resources, commit: (writes: Parameters<typeof resources.commit>[0]) => resources.commit([...writes,
    { operation: "create", type: { ...INPUT_TYPE, kind: "Unregistered" }, name: "failure", spec: {}, status: {} }]) };
  await assert.rejects(assessInput(failing, c, "live", { inputId: "fact", summary: "handoff", workRequests: [{ workUid: w.uid!, request: {} }] }), /Unknown resource/);
  assert.deepEqual(aide.conversations.inputStore.get("fact"), before);
  assert.equal(aide.conversations.resource("me")!.status.summary, undefined);
  assert.deepEqual(aide.conversations.inputStore.query("handlePending", w.uid!), []);
});

test("Input protects every unfinished stage; deleting its Work ends handling and permits quota eviction", async t => {
  const { aide, resources, context } = setup(t);
  const c = await aide.conversations.ensure("me");
  const w = await aide.work("me").create(task);
  const store = aide.conversations.inputStore;
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
