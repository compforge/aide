import { deadlineClock } from "./fixtures/clock.ts";
import { deliverInput } from "./input-state-fixture.ts";
import { BATCH_TYPE } from "../plugins/personal/batch/model.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { secretaryFixture } from "./secretary-fixture.ts";
import { prepareSecretary, reconcileSecretary } from "../plugins/personal/secretary/reconcile.ts";
import { reconcileChief } from "../plugins/personal/chief/reconcile.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { InputAttention } from "../plugins/personal/input/model.ts";

test("Secretary seals a ready Batch during an active Chief turn and selects it after release", async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b");
  await f.resources.patchStatus(f.root(), { execution: { id: "busy", startedAt: new Date().toISOString() } });
  await prepareSecretary(f.context, f.root(), f.policy);
  assert.equal((await reconcileSecretary(f.context, f.root(), f.policy)).intake, undefined);
  await f.resources.patchStatus(f.root(), { execution: null });
  assert.equal(f.calls(), 0); assert.equal((await f.resources.list(BATCH_TYPE)).length, 1);
  await reconcileChief(f.context, f.execution(), f.root(), f.policy); assert.equal(f.calls(), 1);
});

test("Chief commits review results and scheduling facts once without Secretary settlement", async t => {
  const f = await secretaryFixture(t);
  await f.resources.patchStatus(f.root(), { weaveRevision: 1 });
  await reconcileSecretary(f.context, f.root(), f.policy);
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:curate")!;
  assert.ok(review.spec.observation?.review); assert.equal(f.calls(), 0);
  await reconcileChief(f.context, f.execution(), f.root(), f.policy);
  assert.ok(f.aide.topics.inputStore.get(review.metadata.name)!.status.assess?.completedAt);
  assert.equal(f.root().status.chiefWorkload?.reviewed, (review.spec.observation!.review as { completed: number }).completed);
  assert.equal(f.root().status.chiefWorkload?.completed, 1);
  const count = f.root().status.chiefWorkload?.completed;
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.root().status.chiefWorkload?.completed, count);
  assert.equal(f.calls(), 1);
});

test("Maintenance remains an independent Input behind ordinary business", async t => {
  const f = await secretaryFixture(t);
  await f.input("review", InputAttention.Normal, "aide:curate");
  await f.input("business", InputAttention.Normal);
  await reconcileChief(f.context, f.execution(), f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.get("review")!.status.assess?.executionId, undefined);
  assert.ok(f.aide.topics.inputStore.get("business")!.status.assess?.completedAt);
  assert.equal((await f.resources.list(BATCH_TYPE)).length, 0);
});

// @case Structure notification is acknowledged only by successful review, but failures still back off.
test("Secretary defers preparation while Chief is busy and failed structure review does not hot-loop", async t => {
  const f = await secretaryFixture(t);
  await f.resources.patchStatus(f.root(), { execution: { id: "busy", startedAt: new Date().toISOString() }, weaveRevision: 1 });
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.calls(), 0);
  assert.equal(f.aide.topics.inputStore.list().length, 0);
  await f.resources.patchStatus(f.root(), { execution: null });
  await reconcileSecretary(f.context, f.root(), f.policy);
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:curate")!;
  assert.ok(review.spec.observation?.review); assert.ok(f.root().status.maintenanceChecks?.["aide:curate"]);
  await f.resources.patchStatus(f.root(), { execution: null });
  await reconcileChief(f.context, f.execution("failure", async () => { throw new Error("provider failed"); }), f.root(), f.policy);
  await reconcileSecretary(f.context, f.root(), f.policy);
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:curate").length, 1);
  assert.equal(f.root().status.notifiedWeaveRevision ?? 0, 0);
  assert.equal(f.aide.topics.inputStore.get(review.metadata.name)!.status.assess?.retryable, true);
});

// @case A rejected result transaction leaves both Input and maintenance scheduling uncommitted.
test("Review completion failure retries atomically and repeated completion cannot increment backoff", async t => {
  const f = await secretaryFixture(t);
  await f.resources.patchStatus(f.root(), { weaveRevision: 1 });
  await reconcileSecretary(f.context, f.root(), f.policy);
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:curate")!;
  await reconcileChief(f.context, f.execution("write-failure", async () => {
    const failing = { ...f.resources, async commit() { throw new Error("receipt store unavailable"); } };
    await deliverInput(failing, f.root(), "write-failure", review.metadata.name);
  }), f.root(), f.policy);
  const pending = f.aide.topics.inputStore.get(review.metadata.name)!;
  assert.equal(pending.status.assess?.completedAt, undefined);
  assert.equal(pending.status.assess?.retryable, true);
  assert.equal(f.root().status.notifiedWeaveRevision ?? 0, 0);
  assert.equal(f.root().status.chiefWorkload?.completed ?? 0, 0);
  await f.resources.patchStatus(pending, { assess: { ...pending.status.assess, errorAt: new Date(Date.now() - 61_000).toISOString() } });
  await reconcileChief(f.context, f.execution("retry", async () => {
    const args = { inputId: review.metadata.name, summary: "checked" };
    await deliverInput(f.resources, f.root(), "retry", args.inputId);
    const after = f.root();
    assert.equal(after.status.notifiedWeaveRevision, 1);
    assert.equal(after.status.chiefWorkload?.completed, 1);
    await deliverInput(f.resources, f.root(), "retry", args.inputId);
    assert.equal(f.root().metadata.resourceVersion, after.metadata.resourceVersion);
  }), f.root(), f.policy);
  assert.ok(f.aide.topics.inputStore.get(review.metadata.name)!.status.assess?.completedAt);
  const receipt = f.aide.topics.inputStore.get(review.metadata.name)!;
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.get(review.metadata.name)!.metadata.resourceVersion, receipt.metadata.resourceVersion);
  // A later structure change is a new task with a new Input identity.
  deadlineClock(t)(61_000);
  await f.resources.patchStatus(f.root(), { weaveRevision: 2 });
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:curate").length, 2);
});

// @case A conflicting scheduling update rolls back the receipt, then recomputes the counter exactly once.
test("Maintenance completion retries a conflicting Topic write atomically", async t => {
  const f = await secretaryFixture(t);
  await f.resources.patchStatus(f.root(), { weaveRevision: 1 });
  await reconcileSecretary(f.context, f.root(), f.policy);
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:curate")!;
  let raced = false, rolledBack = false;
  await reconcileChief(f.context, f.execution("race", async () => {
    const resources = { ...f.resources, async commit(writes: Parameters<typeof f.resources.commit>[0]) {
      if (!raced) {
        raced = true;
        await f.resources.patchStatus(f.root(), { chiefWorkload: { completed: 5, reviewed: 0, pendingSince: null } });
        try { return await f.resources.commit(writes); }
        catch (error) {
          rolledBack = true;
          assert.equal(f.aide.topics.inputStore.get(review.metadata.name)!.status.assess?.completedAt, undefined);
          assert.equal(f.root().status.notifiedWeaveRevision ?? 0, 0);
          throw error;
        }
      }
      return f.resources.commit(writes);
    } };
    await deliverInput(resources, f.root(), "race", review.metadata.name);
    assert.equal(f.root().status.chiefWorkload?.completed, 6);
    assert.equal(f.root().status.notifiedWeaveRevision, 1);
  }), f.root(), f.policy);
  assert.ok(raced && rolledBack);
  assert.ok(f.aide.topics.inputStore.get(review.metadata.name)!.status.assess?.completedAt);
});

// @case Workload is durable completion accounting, not execution count or Input origin filtering.
test("Every Chief origin counts once and successful receipt retries never count again", async t => {
  const f = await secretaryFixture(t);
  const origins = ["source", "channel", "chief", "aide:followup", "aide:organize", "aide:curate"] as const;
  for (const [index, origin] of origins.entries()) {
    const id = `item-${index}`, executionId = `run-${index}`;
    await f.input(id, InputAttention.Normal, origin);
    await reconcileChief(f.context, f.execution(executionId, async () => {
      await deliverInput(f.resources, f.root(), executionId, id);
      await deliverInput(f.resources, f.root(), executionId, id);
    }), f.root(), f.policy);
    assert.equal(f.root().status.chiefWorkload?.completed, index + 1);
  }
  assert.equal(f.root().status.chiefWorkload?.reviewed, 0);
});

test("Secretary schedules by completion count and Review preserves work completed after its snapshot", async t => {
  const f = await secretaryFixture(t);
  f.policy.review.completedInputs = 2;
  await f.input("first", InputAttention.Normal);
  await reconcileChief(f.context, f.execution("one"), f.root(), f.policy);
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:curate").length, 0);
  await f.input("second", InputAttention.Normal);
  await reconcileChief(f.context, f.execution("two"), f.root(), f.policy);
  await reconcileSecretary(f.context, f.root(), f.policy);
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:curate")!;
  assert.equal(review.spec.observation?.trigger, "workload");
  assert.equal((review.spec.observation?.review as { completed: number }).completed, 2);
  let lateAt = "";
  await reconcileChief(f.context, f.execution("review", async () => {
    await f.input("late", InputAttention.Normal);
    await deliverInput(f.resources, f.root(), "review", "late");
    lateAt = f.aide.topics.inputStore.get("late")!.status.assess!.completedAt!;
    await deliverInput(f.resources, f.root(), "review", review.metadata.name);
  }), f.root(), f.policy);
  assert.equal(f.root().status.chiefWorkload?.completed, 4, "Review itself contributes one completion");
  assert.equal(f.root().status.chiefWorkload?.reviewed, 2, "later work is not swallowed by Review acknowledgement");
  assert.equal(f.root().status.chiefWorkload?.pendingSince, lateAt);
});

test("Time trigger uses the earliest unreviewed completion and later work cannot postpone it", async t => {
  const f = await secretaryFixture(t);
  await f.input("first", InputAttention.Normal);
  await reconcileChief(f.context, f.execution("one"), f.root(), f.policy);
  const since = new Date(Date.now() - 901_000).toISOString();
  await f.resources.patchStatus(f.root(), { chiefWorkload: { ...f.root().status.chiefWorkload!, pendingSince: since } });
  await f.input("second", InputAttention.Normal);
  await reconcileChief(f.context, f.execution("two"), f.root(), f.policy);
  assert.equal(f.root().status.chiefWorkload?.pendingSince, since);
  await reconcileSecretary(f.context, f.root(), f.policy);
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:curate")!;
  assert.equal(review.spec.observation?.trigger, "idle");
  await reconcileChief(f.context, f.execution("review"), f.root(), f.policy);
  assert.equal(f.root().status.chiefWorkload?.pendingSince ?? null, null);
  await f.resources.patchStatus(f.root(), { reviewCheckedAt: new Date(0).toISOString(), idleReviewReset: null });
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:curate").length, 1,
    "Review's own completion does not reopen a timed window");
});

test("Review renaming a child Note does not create a new maintenance need", async t => {
  const f = await secretaryFixture(t);
  const { upsertTopicNote } = await import("../plugins/personal/topic/state.ts");
  const child = await f.aide.topics.ensure("child");
  await f.resources.replace(child, { ...child.spec, parentRef: resourceRef(f.root()) }, child.status);
  await f.resources.patchStatus(f.root(), { execution: { id: "write", startedAt: new Date().toISOString() } });
  const note = await upsertTopicNote(f.resources, f.root(), "write", { nature: "semantic", subject: resourceRef(child), name: "old", text: "unchanged facts" }, "note");
  await f.resources.patchStatus(f.root(), { execution: null, chiefWorkload: { completed: 1, reviewed: 0, pendingSince: new Date(0).toISOString() } });
  await reconcileSecretary(f.context, f.root(), f.policy);
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:curate")!;
  await reconcileChief(f.context, f.execution("rename", async () => {
    const updated = await upsertTopicNote(f.resources, f.root(), "rename", { noteId: note.noteId, version: note.version, name: "new", text: "unchanged facts" }, "rename");
    assert.notEqual(updated.version, note.version);
    await deliverInput(f.resources, f.root(), "rename", review.metadata.name);
  }), f.root(), f.policy);
  for (let i = 0; i < 3; i++) {
    await f.resources.patchStatus(f.root(), { reviewCheckedAt: new Date(0).toISOString(), idleReviewReset: null });
    await reconcileSecretary(f.context, f.root(), f.policy);
  }
  assert.equal(f.calls(), 1);
  assert.equal(f.aide.topics.inputStore.list().length, 1);
  assert.equal(f.root().status.chiefWorkload?.completed, 2);
});

// @case Work status is pressure evidence, never an implicit Chief completion.
test("Task and Routine status updates do not count as Chief workload", async t => {
  const f = await secretaryFixture(t);
  await f.input("initial");
  const { TASK_TYPE } = await import("../plugins/personal/task/model.ts");
  const { ROUTINE_TYPE } = await import("../plugins/personal/routine/model.ts");
  for (const [type, id] of [[TASK_TYPE, "task"], [ROUTINE_TYPE, "routine"]] as const) {
    const work = await f.resources.create<unknown, import("../plugins/personal/work/agent-status.ts").WorkAgentStatus>(type, { name: id,
      spec: { title: id, instruction: "Independent work", ...(id === "task" ? { initialInputId: "initial" } : { trigger: { cron: null, timezone: "UTC", event: "changed" } }) }, status: { topic: resourceRef(f.root()) } });
    await f.resources.patchStatus(work, { idleSince: new Date().toISOString() });
  }
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.root().status.chiefWorkload?.completed ?? 0, 0);
  assert.equal(f.calls(), 0);
});

test("Unchanged organization pressure backs off instead of reissuing every base cooldown", async t => {
  const f = await secretaryFixture(t);
  const advance = deadlineClock(t);
  f.policy.maxUnfiledInput = 1;
  await f.input("one", InputAttention.Normal); await f.input("two", InputAttention.Normal);
  await reconcileChief(f.context, f.execution("first"), f.root(), f.policy);
  await reconcileChief(f.context, f.execution("second"), f.root(), f.policy);
  const reviews = () => f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:organize");
  for (const round of [1, 2]) {
    await reconcileSecretary(f.context, f.root(), f.policy);
    assert.equal(reviews().length, round);
    await reconcileChief(f.context, f.execution(`organize-${round}`), f.root(), f.policy);
    if (round === 1) advance(61_000);
  }
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(reviews().length, 2, "second unchanged attempt waits 120 seconds");
  assert.equal(f.root().status.maintenanceChecks?.["aide:organize"]?.attempts, 2);
  advance(61_000);
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(reviews().length, 3);
});

test("Input collection cannot erase Chief completion demand", async t => {
  const f = await secretaryFixture(t);
  const { collectResources } = await import("./fixtures/resource-gc.ts");
  await f.input("old", InputAttention.Normal);
  await reconcileChief(f.context, f.execution("business"), f.root(), f.policy);
  f.aide.topics.resources.storage.configure({ kinds: { "aide.dev/Input": { maxCount: 1 } } });
  await collectResources(f.aide.topics.resources.storage);
  assert.equal(f.aide.topics.inputStore.get("old"), undefined);
  assert.equal(f.root().status.chiefWorkload?.completed, 1);
  await f.resources.patchStatus(f.root(), { chiefWorkload: { ...f.root().status.chiefWorkload!, pendingSince: new Date(0).toISOString() } });
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:curate").length, 1);
});

test("Secretary request creation retries a concurrent Chief completion without losing the workload", async t => {
  const f = await secretaryFixture(t);
  await f.resources.patchStatus(f.root(), { weaveRevision: 1 });
  let raced = false;
  const context = { ...f.context, resources: { ...f.resources, async commit(writes: Parameters<typeof f.resources.commit>[0]) {
    if (!raced && writes.some(w => w.operation === "create" && w.type.kind === "Input")) {
      raced = true;
      await f.resources.patchStatus(f.root(), { chiefWorkload: { completed: 5, reviewed: 0, pendingSince: new Date().toISOString() } });
    }
    return f.resources.commit(writes);
  } } };
  await reconcileSecretary(context, f.root(), f.policy);
  assert.ok(raced);
  const reviews = f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:curate");
  assert.equal(reviews.length, 1);
  assert.equal((reviews[0]!.spec.observation?.review as { completed: number }).completed, 5);
  assert.equal(f.root().status.chiefWorkload?.completed, 5);
  assert.equal(f.root().status.chiefWorkload?.requestedThrough, 5);
});

test("Maintenance backoff reaches two hours even with a one-second base cooldown", async t => {
  const f = await secretaryFixture(t), advance = deadlineClock(t);
  f.policy.review.idleSeconds = 10800;
  f.policy.review.backoff = null;
  f.policy.workWindowSeconds = 10800;
  f.policy.maxUnfiledInput = 1; f.policy.capacityCooldownSeconds = 1;
  await f.input("one", InputAttention.Normal); await f.input("two", InputAttention.Normal);
  await reconcileChief(f.context, f.execution("first"), f.root(), f.policy);
  await reconcileChief(f.context, f.execution("second"), f.root(), f.policy);
  await reconcileSecretary(f.context, f.root(), f.policy);
  await reconcileChief(f.context, f.execution("organize"), f.root(), f.policy);
  const request = f.root().status.maintenanceChecks!["aide:organize"]!;
  await f.resources.patchStatus(f.root(), { maintenanceChecks: { "aide:organize": { ...request, attempts: 14 } } });
  const count = () => f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:organize").length;
  advance(7199_000); await reconcileSecretary(f.context, f.root(), f.policy); assert.equal(count(), 1);
  advance(2000); await reconcileSecretary(f.context, f.root(), f.policy); assert.equal(count(), 2);
  assert.equal(f.root().status.maintenanceChecks!["aide:organize"]!.attempts, 14);
});

test("window expiry postpones a due Ongoing until fresh external business is handled", async t => {
  const { upsertOngoing } = await import("../plugins/personal/ongoing/service.ts");
  const f = await secretaryFixture(t);
  const at = new Date(0).toISOString();
  await f.resources.patchStatus(f.root(), { lastInputAt: at, execution: { id: "setup", startedAt: at } });
  await upsertOngoing(f.resources, f.root(), { title: "Check receipt", checkAt: at }, "setup");
  await f.resources.patchStatus(f.root(), { execution: null });
  assert.equal((await reconcileSecretary(f.context, f.root(), f.policy)).intake, undefined);
  assert.equal(f.aide.topics.inputStore.list().length, 0);
  await f.input("external-reply", InputAttention.Normal, "channel");
  await reconcileChief(f.context, f.execution("reply"), f.root(), f.policy);
  assert.ok(f.aide.topics.inputStore.get("external-reply")!.status.assess?.completedAt);
  assert.equal((await reconcileSecretary(f.context, f.root(), f.policy)).intake?.inputs[0]?.spec.origin, "aide:followup");
});


test("Business closes a due Ongoing before the Secretary ever creates a followup", async t => {
  const { readOngoing, upsertOngoing } = await import("../plugins/personal/ongoing/service.ts");
  const f = await secretaryFixture(t);
  await f.resources.patchStatus(f.root(), { execution: { id: "setup", startedAt: new Date().toISOString() } });
  const work = await upsertOngoing(f.resources, f.root(), { title: "Await delivery confirmation", checkAt: new Date(0).toISOString() }, "setup");
  await f.input("confirmed", InputAttention.Normal);
  assert.equal((await reconcileSecretary(f.context, f.root(), f.policy)).intake, undefined);
  await f.resources.patchStatus(f.root(), { execution: null });
  await reconcileChief(f.context, f.execution("close", async () => {
    await deliverInput(f.resources, f.root(), "close", "confirmed");
    const current = await readOngoing(f.resources, f.root(), work.id);
    await upsertOngoing(f.resources, f.root(), { ongoingId: work.id, version: current.metadata.resourceVersion, outcome: "User confirmed delivery" }, "close");
  }), f.root(), f.policy);
  assert.ok((await readOngoing(f.resources, f.root(), work.id)).status.closure);
  assert.equal((await reconcileSecretary(f.context, f.root(), f.policy)).intake, undefined);
  assert.ok(!f.aide.topics.inputStore.list().some(i => i.spec.origin === "aide:followup"));
});

test("Stow qualifies strictly above the threshold, yields to maintenance, and reserves one prompt", async t => {
  const f = await secretaryFixture(t);
  const agent = { harness: "chief", sessionId: "current", promptTokens: f.policy.stowPromptTokens };
  await f.resources.patchStatus(f.root(), { agent });
  const select = async () => (await reconcileSecretary(f.context, f.root(), f.policy)).intake?.inputs[0];
  assert.equal(await select(), undefined);
  await f.resources.patchStatus(f.root(), { agent: { ...agent, promptTokens: agent.promptTokens + 1 }, weaveRevision: 1 });
  assert.equal((await select())?.spec.origin, "aide:curate");
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:stow").length, 0);
  await reconcileChief(f.context, f.execution("review"), f.root(), f.policy);
  const stow = await select();
  assert.equal(stow?.spec.origin, "aide:stow");
  assert.equal((await select())?.metadata.uid, stow?.metadata.uid);
  assert.equal(f.root().status.agent?.promptTokens, agent.promptTokens + 1);
  await f.resources.patchStatus(f.root(), { lastInputAt: new Date(0).toISOString() });
  assert.equal(await select(), undefined);
});
