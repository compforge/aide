import { InputAttention } from "../plugins/personal/input/model.ts";
import { attemptOf, resourceRef } from "../plugins/personal/input/state.ts";
import type { PluginContext, ReconcileContext, ResourceCommit } from "@compforge/aide-plugin";
import { reconcileChief } from "../plugins/personal/topic/reconcile.ts";
import { reconcileRouteAgent } from "../plugins/personal/route/reconcile.ts";
import { ROUTE_TYPE, ROUTE_NAME, type RouteResource } from "../plugins/personal/route/model.ts";
import type { TopicResource } from "../plugins/personal/topic/model.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions, type Agent } from "./fake-harness.ts";
import { assessAll } from "./input-state-fixture.ts";
import { routeTo } from "./input-state-fixture.ts";
import { admit } from "./input-state-fixture.ts";
import type { LoopStatus } from "../plugins/personal/loop.ts";

function setup(t: { after(fn: () => Promise<void>): void }, agent: Partial<Agent> = {}) {
  const root = mkdtempSync(join(tmpdir(), "aide-continuous-"));
  const options = fakeOptions({ notify: false, async execute() { throw new Error("No work"); }, ...agent }, root);
  const aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const submit = (id: string, attention: InputAttention = InputAttention.Normal) => aide.topics.submit(id,
    { topicId: "me", origin: "source", originId: "personal.environments", text: `fact ${id}`, attention });
  return { aide, submit, root, options };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(20); }
  assert.ok(check(), "Timed out");
}

test("Chief can assess material without claiming it; redelivery and repeated completion are idempotent", async t => {
  const { aide, submit } = setup(t);
  const c = await aide.topics.ensure("me");
  const client = aide.runtime.plugins.resourceClient("personal");
  for (const id of ["one", "later"]) await routeTo(client, c.metadata, await submit(id));
  await client.patchStatus(aide.topics.resource("me")!, { execution: { id: "live", startedAt: new Date().toISOString() } });
  await admit(client, "one", "live");
  assert.deepEqual(aide.topics.get("me")!.pendingInputIds, ["one", "later"]);
  await assessAll(client, c, "live", { inputIds: ["one"], summary: "Nothing needs action" });
  await assessAll(client, c, "live", { inputIds: ["one"], summary: "Nothing needs action" });
  assert.deepEqual(aide.topics.get("me")!.pendingInputIds, ["later"]);
  await assessAll(client, c, "live", { inputIds: ["later"], summary: "Read directly without notification" });
  assert.equal(await routeTo(client, c.metadata, aide.topics.inputStore.get("one")!), false);
  assert.equal(aide.outputs().length, 0);
  assert.equal(aide.topics.resource("me")!.status.summary, "");
  assert.deepEqual(aide.topics.resource("me")!.status.recent, []);
  await assert.rejects(assessAll(client, c, "old", { inputIds: ["one"], summary: "stale" }), /no longer active/);
});

test("Normal arrivals follow up without repeating old prompt material or deleting concurrent arrivals", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const { aide, submit } = setup(t, { async chief(prompt) { calls.push(prompt); if (calls.length === 1) await gate; return "Handled"; } });
  t.after(() => release());
  await aide.topics.ensure("me"); await aide.start();
  await submit("first"); await until(() => calls.length === 1);
  await submit("later"); await until(() => aide.topics.get("me")!.pendingInputIds.includes("later"));
  assert.equal(calls.length, 1);
  release(); await aide.settled();
  assert.equal(calls.length, 2); assert.doesNotMatch(calls[1]!, /fact first/);
  assert.deepEqual(aide.topics.get("me")!.pendingInputIds, []);
});

test("Model end_turn leaves unreviewed material without automatically resending it", async t => {
  let calls = 0;
  const { aide, submit, root, options } = setup(t, { complete: false, async chief() { calls++; return "I handled it"; } });
  await aide.topics.ensure("me"); await aide.start(); await submit("unacknowledged"); await aide.settled();
  assert.equal(calls, 1); assert.equal(aide.topics.input("unacknowledged", "me")!.consumption.phase, undefined);
  assert.ok(aide.topics.inputStore.get("unacknowledged")!.status.assess?.executionId);
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
  await aide.topics.ensure("me"); await aide.start(); await submit("first"); await until(() => calls === 1);
  await submit("urgent", InputAttention.Immediate); await until(() => aide.topics.get("me")!.pendingInputIds.includes("urgent"));
  assert.equal(calls, 1); release(); await aide.settled(); assert.equal(calls, 2);
  assert.deepEqual(aide.topics.get("me")!.pendingInputIds, []);
});


/** @case Transient tail-write errors retry finalization without replaying effects or wedging a resource's serial agent queue. */
for (const kind of ["Topic", "Route"] as const) for (const failure of ["write failure", "version conflict"] as const) {
  test(`${kind} recovers finalization after ${failure} without restarting or replaying Harness`, async t => {
    const { aide, submit } = setup(t);
    const client = aide.runtime.plugins.resourceClient("personal");
    const c = await aide.topics.ensure("me");
    const first = kind === "Topic" ? await submit("first")
      : await aide.topics.submit("first", { origin: "source", originId: "fixture", text: "unmatched fact" });
    let resource: TopicResource | RouteResource;
    if (kind === "Topic") { await routeTo(client, c.metadata, first); resource = aide.topics.resource("me")!; }
    else resource = await client.create(ROUTE_TYPE, { name: ROUTE_NAME, spec: {}, status: {} });
    let failures = failure === "write failure" ? 1 : 9;
    let calls = 0;
    const context = { resources: { ...client, async commit(writes: readonly ResourceCommit[]) {
      if (writes.some(w => w.operation === "patchStatus" && (w.patch as { execution?: unknown }).execution === null) && failures-- > 0) throw new Error(failure);
      return client.commit(writes);
    } }, logger: { info() {}, warn() {}, error() {} }, instance: { config: {} } } as unknown as PluginContext;
    const execution = (executionId: string): ReconcileContext => {
      const e = { executionId, withContext() { return e; }, verbs: { async harness() { calls++; return { state: "failure" }; } } };
      return e as unknown as ReconcileContext;
    };
    const read = async () => (await client.get<unknown, LoopStatus>({ ...resource, ...resource.metadata }))!;
    const reconcile = async (id: string) => kind === "Topic"
      ? reconcileChief(context, execution(id), await read() as TopicResource)
      : reconcileRouteAgent(context, execution(id), await read() as RouteResource);
    await assert.rejects(reconcile("attempted"), new RegExp(failure));
    assert.equal((await read()).status.execution?.id, "attempted");
    assert.equal(!!attemptOf(aide.topics.inputStore.get("first")!, resourceRef(resource))?.executionId, true);
    await reconcile("finalization-retry");
    assert.equal((await read()).status.execution, null);
    assert.ok(kind === "Topic" ? ((await read()).status as TopicResource["status"]).lastError : attemptOf(aide.topics.inputStore.get("first")!, resourceRef(resource))?.lastError);
    assert.equal(calls, 1);
    const next = await aide.topics.submit("next", { origin: "source", originId: "fixture", text: "new fact" });
    if (kind === "Topic") await routeTo(client, c.metadata, next);

    await reconcile("next-call");
    assert.equal(calls, 2);
    assert.equal(attemptOf(aide.topics.inputStore.get("first")!, resourceRef(resource))?.executionId, "attempted");
  });
}

/** @case Notification progress does not recursively wake the intake controller after a rejected native verb. */
test("Chief notification bookkeeping does not wake Topic Reconcile", async t => {
  const { registerTopics } = await import("../plugins/personal/topic/reconcile.ts");
  const { aide } = setup(t);
  const resources = aide.runtime.plugins.resourceClient("personal");
  const topic = await aide.topics.ensure("me");
  const definitions: any[] = [];
  registerTopics({ resources, instance: { config: {} }, controllers: { register(definition: unknown) { definitions.push(definition); } } } as unknown as PluginContext);
  const notified = await resources.patchStatus(topic, { notifiedWeaveRevision: 1 });
  const reverted = await resources.patchStatus(notified, { notifiedWeaveRevision: 0 });
  const changed = await resources.patchStatus(reverted, { weaveRevision: 2 });
  for (const definition of definitions) {
    const watch = definition.watches.find((w: any) => w.resourceType.kind === "Topic");
    assert.deepEqual(await watch.handler.update({ oldObject: topic, newObject: notified }), []);
    assert.deepEqual(await watch.handler.update({ oldObject: notified, newObject: reverted }), []);
    assert.deepEqual(await watch.handler.update({ oldObject: reverted, newObject: changed }),
      definition.name === "summary" ? [] : [{ name: topic.metadata.name, namespace: "v1" }]);
  }
});
