import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { PluginContext, ReconcileContext, ResourceClient } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { reconcileAssignments } from "../plugins/personal/topic/assignment.ts";
import { invalidateAssignment } from "../plugins/personal/input/assignment.ts";
import { assignInput, registerInputs } from "../plugins/personal/input/assignment.ts";
import { INPUT_TYPE, InputAttention, type InputSpec, type InputStatus } from "../plugins/personal/input/model.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { TOPIC_TYPE, type TopicResource } from "../plugins/personal/topic/model.ts";
import { ensureCapacityInputs } from "../plugins/personal/topic/maintenance.ts";
import { topicPolicy } from "../plugins/personal/topic/config.ts";
import { assessInput } from "../plugins/personal/topic/assess.ts";
import { nextInputs, runInput } from "../plugins/personal/loop.ts";
import { deliver } from "../plugins/personal/route/delivery.ts";

async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-assignment-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected Work"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const root = await aide.topics.ensure("root"), other = await aide.topics.ensure("other");
  const initialChild = await aide.topics.ensure("child");
  const child = await resources.replace(initialChild, { ...initialChild.spec, parentRef: resourceRef(root) }, initialChild.status);
  const context = { resources, logger: { info() {}, warn() {}, error() {} }, instance: { config: { topic: topicPolicy({ maxUnfiledInput: 1, maxChildren: 1 }) } } } as unknown as PluginContext;
  const read = (topic: TopicResource) => aide.topics.resource(topic.spec.id)!;
  const input = async (id: string, topic = child, topicKey?: string) => {
    const fact = aide.topics.inputStore.submit("fixture", id, { origin: "source", originId: "fixture", text: id, topicKey });
    await deliver(context, fact, [topic.metadata], "Fixture routing");
    return aide.topics.inputStore.get(id)!;
  };
  const prompts: string[] = [];
  const execution = (id: string, action?: () => Promise<void>) => ({ executionId: id, withContext() { return this; }, verbs: { async harness(args: { operation?: string; prompt: string }) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: id } };
    prompts.push(args.prompt); await action?.();
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } } as unknown as ReconcileContext);
  return { aide, resources, root, other, child, context, read, input, execution, prompts };
}

test("Mounted Input recovers assignment independently; root pending lookup never scans Topics", async t => {
  const f = await fixture(t);
  const fact = await f.resources.create<InputSpec, InputStatus>(INPUT_TYPE, { name: "mounted", spec: { origin: "source", originId: "fixture", text: "persisted mount" },
    status: { topic: resourceRef(f.child), route: { completedAt: new Date().toISOString() }, assess: {} } });
  await assignInput(f.context, fact);
  const assigned = f.aide.topics.inputStore.get("mounted")!;
  assert.equal(assigned.status.topic!.uid, f.child.metadata.uid);
  assert.equal(assigned.status.assess!.topic!.uid, f.root.metadata.uid);
  let queries = 0;
  const resources: ResourceClient = { ...f.resources,
    list: async () => { throw new Error("No unbounded lists"); },
    get: async () => { throw new Error("No Topic discovery"); },
    async page(type, options) { assert.equal(type.kind, "Input"); queries++; return f.resources.page(type, options); },
  };
  assert.deepEqual((await nextInputs(resources, f.read(f.root), 8)).map(i => i.metadata.name), ["mounted"]);
  assert.ok(queries <= 6);
});

test("An ancestor move redistributes pending Inputs while preserving an old execution and its completion", async t => {
  const f = await fixture(t);
  const fact = await f.input("in-flight");
  await runInput(f.context, f.execution("old-chief", async () => {
    const oldRoot = f.read(f.root);
    await f.resources.replace(oldRoot, { ...oldRoot.spec, parentRef: resourceRef(f.other) }, oldRoot.status);
    await assignInput(f.context, f.aide.topics.inputStore.get("in-flight")!);
    const moved = f.aide.topics.inputStore.get("in-flight")!;
    assert.equal(moved.status.topic!.uid, f.child.metadata.uid);
    assert.equal(moved.status.assess!.topic!.uid, f.root.metadata.uid);
    assert.equal(moved.status.assess!.executionId, "old-chief");
    assert.deepEqual(await nextInputs(f.resources, f.read(f.other), 8), []);
    await assessInput(f.resources, f.read(f.root), "old-chief", { inputId: fact.metadata.name, summary: "Old Chief finishes" });
  }), f.read(f.root), "chief", "original", fact.metadata.name);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.aide.topics.inputStore.get("in-flight")!.status.assess!.result!.summary, "Old Chief finishes");
  assert.deepEqual(await nextInputs(f.resources, f.read(f.other), 8), []);
});

test("Transaction rejects a stale assignee even before the topology watcher updates the Input", async t => {
  const f = await fixture(t);
  const fact = await f.input("pending");
  const child = f.read(f.child);
  await f.resources.replace(child, { ...child.spec, parentRef: resourceRef(f.other) }, child.status);
  await runInput(f.context, f.execution("stale"), f.read(f.root), "chief", "stale", fact.metadata.name);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.read(f.root).status.execution, undefined);
  await assignInput(f.context, f.aide.topics.inputStore.get("pending")!);
  await runInput(f.context, f.execution("current"), f.read(f.other), "chief", "current", fact.metadata.name);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.aide.topics.inputStore.get("pending")!.status.assess!.executionId, "current");
});

test("Missing assignment triggers only the Input watch and is repaired even when that notification is lost", async t => {
  const f = await fixture(t); const before = await f.input("deep");
  await reconcileAssignments(f.context, f.read(f.child));
  const registrations: Parameters<PluginContext["controllers"]["register"]>[0][] = [];
  registerInputs({ ...f.context, controllers: { register: c => { registrations.push(c); } } } as PluginContext);
  assert.equal(registrations[0]!.watches!.length, 1);
  await invalidateAssignment(f.context, f.aide.topics.inputStore.get("deep")!);
  const after = f.aide.topics.inputStore.get("deep")!;
  assert.equal(after.status.assess!.topic, undefined);
  assert.deepEqual(await registrations[0]!.watches![0]!.handler.update({ oldObject: before, newObject: after } as never), [{ name: "deep", namespace: "v1" }]);
  await reconcileAssignments(f.context, f.read(f.child));
  assert.equal(f.aide.topics.inputStore.get("deep")!.status.assess!.topic!.uid, f.root.metadata.uid);
});

test("Periodic direct reconciliation notices ancestor moves, including an A-B-A move between checks", async t => {
  const f = await fixture(t); await f.input("deep");
  await reconcileAssignments(f.context, f.read(f.child));
  const version = f.read(f.child).status.assignmentRefresh!.version;
  let root = f.read(f.root);
  await f.resources.replace(root, { ...root.spec, parentRef: resourceRef(f.other) }, root.status);
  await assignInput(f.context, f.aide.topics.inputStore.get("deep")!);
  root = f.read(f.root); const { parentRef, ...spec } = root.spec;
  await f.resources.replace(root, spec, root.status);
  await reconcileAssignments(f.context, f.read(f.child));
  assert.notEqual(f.read(f.child).status.assignmentRefresh!.version, version);
  assert.equal(f.aide.topics.inputStore.get("deep")!.status.assess!.topic!.uid, f.root.metadata.uid);
});

test("Refresh resumes bounded pages after interruption and a second root change", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 45; i++) await f.input(`item-${String(i).padStart(3, "0")}`);
  const root = f.read(f.root);
  await f.resources.replace(root, { ...root.spec, parentRef: resourceRef(f.other) }, root.status);
  let reads = 0;
  const failing = { ...f.context, resources: { ...f.resources, page: async (...args: Parameters<ResourceClient["page"]>) => {
    if (++reads === 2) throw new Error("interrupted after checkpoint");
    return f.resources.page(...args);
  } } } as PluginContext;
  await assert.rejects(reconcileAssignments(failing, f.read(f.child)), /interrupted/);
  assert.ok(f.read(f.child).status.assignmentRefresh!.cursor);
  assert.equal(f.aide.topics.inputStore.get("item-000")!.status.assess!.topic, undefined);
  const third = await f.aide.topics.ensure("third");
  const other = f.read(f.other);
  await f.resources.replace(other, { ...other.spec, parentRef: resourceRef(third) }, other.status);
  await reconcileAssignments(f.context, f.read(f.child));
  await reconcileAssignments(f.context, f.read(f.child));
  assert.ok(f.read(f.child).status.assignmentRefresh!.complete);
  assert.ok(f.aide.topics.inputStore.list().every(i => i.status.assess!.topic!.uid === third.metadata.uid));
  const child = f.read(f.child);
  await f.resources.replace(child, { ...child.spec, parentRef: resourceRef(f.other) }, child.status);
  let more = true, rounds = 0;
  while (more && rounds++ < 4) more = await reconcileAssignments(f.context, f.read(f.child));
  assert.equal(more, false);
  assert.ok(f.aide.topics.inputStore.list().every(i => i.status.assess!.topic!.uid === third.metadata.uid));
});

test("Child capacity creates deduplicated built-in Inputs assigned to root and excludes keyed and internal material", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) await f.input(`keyed-${i}`, f.child, "source:key");
  await f.input("unfiled-one");
  await ensureCapacityInputs(f.context, f.read(f.child));
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:triage").length, 0);
  await f.input("unfiled-two");
  for (const name of ["grand-a", "grand-b"]) await f.resources.create(TOPIC_TYPE, { name,
    spec: { id: name, parentRef: resourceRef(f.child) }, status: { summary: "", receipts: [] } });
  await Promise.allSettled([ensureCapacityInputs(f.context, f.read(f.child)), ensureCapacityInputs(f.context, f.read(f.child))]);
  await ensureCapacityInputs(f.context, f.read(f.child));
  await ensureCapacityInputs(f.context, f.read(f.child));
  const internal = f.aide.topics.inputStore.list().filter(i => i.spec.origin.startsWith("aide:"));
  assert.deepEqual(internal.map(i => i.spec.origin).sort(), ["aide:organize", "aide:triage"]);
  for (const request of internal) {
    assert.equal(request.status.topic!.uid, f.child.metadata.uid);
    assert.equal(request.status.assess!.topic!.uid, f.root.metadata.uid);
    assert.equal("maintenance" in request.spec, false);
  }
  assert.equal((await nextInputs(f.resources, f.read(f.root), 8))[0]!.spec.origin, "aide:triage");
  assert.equal(f.aide.topics.inputStore.query("unfiled", f.child.metadata.uid).length, 2);
});

test("maxInput is inert and exactly-at-threshold material does not trigger triage", async t => {
  const f = await fixture(t);
  (f.context.instance.config as { topic: unknown }).topic = topicPolicy({ maxInput: 1, maxUnfiledInput: 2 });
  await f.input("one"); await f.input("two");
  await ensureCapacityInputs(f.context, f.read(f.child));
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:triage").length, 0);
});


test("A direct Work event has no assessment phase and does not acquire a Chief assignment", async t => {
  const f = await fixture(t);
  const event = await f.resources.create<InputSpec, InputStatus>(INPUT_TYPE, { name: "event", spec: { origin: "source", originId: "personal.events", text: "subscription" },
    status: { topic: resourceRef(f.child), route: { completedAt: new Date().toISOString() }, handle: {} } });
  await assignInput(f.context, event);
  assert.equal(f.aide.topics.inputStore.get("event")!.status.assess, undefined);
  assert.deepEqual(await nextInputs(f.resources, f.read(f.root), 8), []);
});
