import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { InputAttention, inputAttention } from "../plugins/personal/input/model.ts";
import { InputSpecSchema } from "../plugins/personal/input/definition.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { understandingVersion, summaryVersion } from "../plugins/personal/topic/tree.ts";
import { fakeOptions, type Agent } from "./fake-harness.ts";

function setup(t: { after(fn: () => Promise<void>): void }, agent: Partial<Agent> = {}) {
  const home = mkdtempSync(join(tmpdir(), "aide-attention-"));
  const prompts: string[] = [];
  const options = fakeOptions({ notify: false, async execute() { throw new Error("Unexpected work"); }, ...agent }, home, prompts);
  const aide = new Aide(home, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const client = aide.runtime.plugins.resourceClient("personal");
  const submit = (id: string, topicId = "root", attention = InputAttention.Deferred) =>
    aide.topics.submit(id, { origin: "source", originId: "fixture", topicId, attention, text: `fact ${id}` });
  return { aide, client, submit, prompts, home, options };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(20); }
  assert.ok(check(), "condition did not become true");
}

test("Input attention has three string values and source-specific defaults", () => {
  for (const attention of Object.values(InputAttention))
    assert.equal(InputSpecSchema.parse({ origin: "source", originId: "fixture", text: "fact", attention }).attention, attention);
  assert.throws(() => InputSpecSchema.parse({ origin: "source", originId: "fixture", text: "fact", attention: "default" }));
  for (const origin of ["channel", "source", "chief", "trigger"] as const) {
    assert.equal(inputAttention({ origin, originId: "fixture", text: "fact" }), origin === "channel" ? InputAttention.Immediate : InputAttention.Normal);
    assert.equal(inputAttention({ origin, originId: "fixture", text: "fact", attention: InputAttention.Deferred }), InputAttention.Deferred);
  }
});

/** @case Deferred attachment to roots or children never starts or continues Chief; another input may include the backlog. */
for (const target of ["root", "child"]) test(`Deferred ${target} inputs wait and can join a normally activated Chief`, async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const { aide, client, submit, prompts } = setup(t, { chief: async () => { await gate; return "Handled"; } });
  t.after(() => release());
  const root = await aide.topics.ensure("root");
  if (target === "child") {
    const child = await aide.topics.ensure("child");
    await client.replace(child, { ...child.spec, parentRef: resourceRef(root) }, child.status);
    await client.patchStatus(root, { absorbed: { [child.metadata.uid]: understandingVersion(child) }, absorbedSummaries: { [child.metadata.uid]: summaryVersion(child) } });
  }
  await aide.start();
  await submit("early", target); await aide.settled();
  const early = aide.topics.inputStore.get("early")!;
  assert.ok(early.status.route?.completedAt);
  assert.equal(early.status.route!.result!.topics[0]!.uid, aide.topics.resource(target)!.metadata.uid);
  assert.equal(early.status.assess!.executionId, undefined);
  assert.equal(prompts.length, 0);
  await submit("normal", "root", InputAttention.Normal); await until(() => prompts.length === 1);
  assert.match(prompts[0]!, /fact early/);
  assert.ok(prompts[0]!.indexOf("fact normal") < prompts[0]!.indexOf("fact early"));
  await submit("late", target);
  await until(() => !!aide.topics.inputStore.get("late")?.status.route?.completedAt);
  await Bun.sleep(100);
  assert.equal(aide.topics.inputStore.get("late")!.status.assess!.executionId, undefined);
  assert.equal(aide.topics.resource("root")!.status.execution!.admissionRevision, 0);
  release(); await aide.settled();
  assert.equal(prompts.length, 1, "Late Deferred must not force another turn");
  for (const id of ["early", "normal"]) assert.ok(aide.topics.inputStore.get(id)!.status.assess?.completedAt);
  assert.equal(aide.topics.inputStore.get("late")!.status.assess!.completedAt, undefined);
});

test("Deferred backlog survives restart with trigger disabled and timer reviews remain bounded", async t => {
  const { aide, submit, prompts, home, options } = setup(t);
  const root = await aide.topics.ensure("root");
  await aide.setTopicTrigger("root", false);
  await aide.start();
  for (let i = 0; i < 10; i++) await submit(`deferred-${i}`);
  await aide.settled(); assert.equal(prompts.length, 0);
  await aide.close();
  const restarted = new Aide(home, options, pino({ level: "silent" }));
  try {
    await restarted.start(); await restarted.settled();
    assert.equal(prompts.length, 0);
    const resources = restarted.runtime.plugins.resourceClient("personal");
    for (const remaining of [3, 0]) {
      const c = restarted.topics.resource("root")!;
      await resources.replace(c, { ...c.spec, trigger: { enabled: true } },
        { ...c.status, nextTriggerAt: new Date(Date.now() - 1000).toISOString(), idleSince: new Date(Date.now() - 901_000).toISOString() });
      // Simulate the existing timer's reconcile, including when only its status deadline changed.
      await restarted.runtime.plugins.enqueue({ pluginInstanceId: "personal", namespace: "v1", resourceApiVersion: c.apiVersion,
        resourceKind: c.kind, resourceId: c.metadata.name, controllerName: "agent" });
      await restarted.settled();
      assert.equal(restarted.topics.pending(root.metadata.uid).length, remaining);
      assert.match(prompts.at(-1)!, /"kind":"input"/);
      assert.match(prompts.at(-1)!, /Scheduled review/);
    }
    assert.equal(prompts.length, 2);
    assert.ok(restarted.topics.inputStore.list().every(i => i.status.assess!.completedAt));
  } finally { await restarted.close(); }
});

test("Child understanding can activate Chief and include Deferred without a timer", async t => {
  const { aide, client, submit, prompts } = setup(t);
  const root = await aide.topics.ensure("root"), child = await aide.topics.ensure("child");
  await client.replace(child, { ...child.spec, parentRef: resourceRef(root) }, child.status);
  await client.patchStatus(root, { absorbed: { [child.metadata.uid]: understandingVersion(child) }, absorbedSummaries: { [child.metadata.uid]: summaryVersion(child) } });
  await aide.start(); await submit("deferred", "child"); await aide.settled();
  assert.equal(prompts.length, 0);
  await client.patchStatus(aide.topics.resource("child")!, { summary: "New understanding" });
  await aide.settled();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /"kind":"absorb"/);
  assert.match(prompts[0]!, /fact deferred/);
  assert.ok(aide.topics.inputStore.get("deferred")!.status.assess!.completedAt);
});
