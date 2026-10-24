import { attemptOf, resourceRef } from "../plugins/personal/input/state.ts";
import type { PluginContext, ReconcileContext, ResourceCommit } from "@compforge/aide-plugin";
import { reconcileChief } from "../plugins/personal/conversation/reconcile.ts";
import { reconcileRouteAgent } from "../plugins/personal/route/reconcile.ts";
import { ROUTE_TYPE, ROUTE_NAME, type RouteResource } from "../plugins/personal/route/model.ts";
import type { ConversationResource } from "../plugins/personal/conversation/model.ts";
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
  for (const id of ["one", "later"]) await routeTo(client, c.metadata, await submit(id));
  await client.patchStatus(aide.conversations.resource("me")!, { execution: { id: "live", startedAt: new Date().toISOString() } });
  await admit(client, "one", c.metadata.uid, "live");
  await assert.rejects(assessAll(client, c, "live", { inputIds: ["later"], summary: "invalid" }), /not been admitted/);
  assert.deepEqual(aide.conversations.get("me")!.pendingInputIds, ["one", "later"]);
  await assessAll(client, c, "live", { inputIds: ["one"], summary: "Nothing needs action" });
  await assessAll(client, c, "live", { inputIds: ["one"], summary: "Nothing needs action" });
  assert.deepEqual(aide.conversations.get("me")!.pendingInputIds, ["later"]);
  assert.equal(await routeTo(client, c.metadata, aide.conversations.inputStore.get("one")!), false);
  assert.equal(aide.outputs().length, 0);
  assert.equal(aide.conversations.resource("me")!.status.summary, "");
  assert.deepEqual(aide.conversations.resource("me")!.status.recent, []);
  await assert.rejects(assessAll(client, c, "old", { inputIds: ["one"], summary: "stale" }), /no longer active/);
});

test("Deferred arrivals follow up without repeating old prompt material or deleting concurrent arrivals", async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const { aide, submit } = setup(t, { async chief(prompt) { calls.push(prompt); if (calls.length === 1) await gate; return "Handled"; } });
  t.after(() => release());
  await aide.conversations.ensure("me"); await aide.start();
  await submit("first"); await until(() => calls.length === 1);
  await submit("later"); await until(() => aide.conversations.get("me")!.pendingInputIds.includes("later"));
  assert.equal(calls.length, 1);
  release(); await aide.settled();
  assert.equal(calls.length, 2); assert.doesNotMatch(calls[1]!, /fact first/);
  assert.deepEqual(aide.conversations.get("me")!.pendingInputIds, []);
});

test("Model end_turn without assess_input retains an explicit failure and never silently retries effects", async t => {
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
  await submit("urgent", "immediate"); await until(() => aide.conversations.get("me")!.pendingInputIds.includes("urgent"));
  assert.equal(calls, 1); release(); await aide.settled(); assert.equal(calls, 2);
  assert.deepEqual(aide.conversations.get("me")!.pendingInputIds, []);
});


/** @case Transient tail-write errors retry finalization without replaying effects or wedging a resource's serial agent queue. */
for (const kind of ["Conversation", "Route"] as const) for (const failure of ["write failure", "version conflict"] as const) {
  test(`${kind} recovers finalization after ${failure} without restarting or replaying Harness`, async t => {
    const { aide, submit } = setup(t);
    const client = aide.runtime.plugins.resourceClient("personal");
    const c = await aide.conversations.ensure("me");
    const first = kind === "Conversation" ? await submit("first")
      : await aide.conversations.submit("first", { origin: "source", originId: "fixture", text: "unmatched fact" });
    let resource: ConversationResource | RouteResource;
    if (kind === "Conversation") { await routeTo(client, c.metadata, first); resource = aide.conversations.resource("me")!; }
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
    const reconcile = async (id: string) => kind === "Conversation"
      ? reconcileChief(context, execution(id), await read() as ConversationResource)
      : reconcileRouteAgent(context, execution(id), await read() as RouteResource);
    await assert.rejects(reconcile("attempted"), new RegExp(failure));
    assert.equal((await read()).status.execution?.id, "attempted");
    assert.equal(!!attemptOf(aide.conversations.inputStore.get("first")!, resourceRef(resource))?.executionId, true);
    await reconcile("finalization-retry");
    assert.equal((await read()).status.execution, null);
    assert.equal(!!attemptOf(aide.conversations.inputStore.get("first")!, resourceRef(resource))?.lastError, true);
    assert.equal(calls, 1);
    const next = await aide.conversations.submit("next", { origin: "source", originId: "fixture", text: "new fact" });
    if (kind === "Conversation") await routeTo(client, c.metadata, next);

    await reconcile("next-call");
    assert.equal(calls, 2);
    assert.equal(attemptOf(aide.conversations.inputStore.get("first")!, resourceRef(resource))?.executionId, "attempted");
  });
}
