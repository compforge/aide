import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect, renderHTML, type ModelCall, type ToolCall, type SessionView, type Operation } from "@compforge/agent-observation";
import { inputJob, inputSessions } from "../plugins/personal/observation/job.ts";
import type { Input } from "../plugins/personal/input/state.ts";
import type { Output } from "../plugins/personal/output/model.ts";
import { webAddress } from "../src/channel/address.ts";

const at = "2026-10-26T01:00:00.000Z";
const topic = { apiVersion: "aide.dev/v1alpha1", kind: "Topic", namespace: "v1", name: "topic", uid: "topic-uid" } as const;
const agent = { harness: "chief", sessionId: "native-1" };
function fixture(): Input {
  return { apiVersion: "aide.dev/v1alpha1", kind: "Input", metadata: { name: "input", uid: "uid-1", namespace: "v1", creationTimestamp: at, resourceVersion: "1", generation: 1 },
    spec: { origin: "channel", originId: "web", text: "check this" }, status: {
      route: { completedAt: at, result: { topics: [topic], reason: "explicit selection" } },
      assess: { [topic.uid]: { resource: topic, assignedAt: at, startedAt: at, completedAt: at, agent,
        executionId: "admitted-run", completedBy: { agent, executionId: "recovery-run", toolCallId: "ack" }, result: { summary: "quietly checked", disposition: "completed" } } },
    } };
}
const model: ModelCall = { kind: "model_call", id: "model-1", status: "completed" };
const tool: ToolCall = { kind: "tool_call", id: "tool-1", tool_call_id: "ack", model_call_id: "model-1", status: "completed" };
const session = (): SessionView => ({ schema_version: "agent-ledger/session@1", session: { source: "pi", id: agent.sessionId }, nodes: [model, tool,
  { kind: "tool_call", id: "other-input-tool", tool_call_id: "unrelated" } as ToolCall] });
const output = (): Output => ({ apiVersion: "aide.dev/v1alpha1", kind: "Output", metadata: { ...fixture().metadata, name: "output", uid: "output-1" },
  spec: { text: "answer", topic, topicId: "topic", target: webAddress("topic"), inputIds: ["input"], inputUids: { input: "uid-1" },
    createdBy: { agent, executionId: "recovery-run", toolCallId: "say" } }, status: { phase: "failed", attempts: 1, lastError: "transport unavailable" } });

test("Job joins explicit acknowledgement and shared model, not all calls in a continuous Session", async () => {
  const input = fixture();
  const job = await inputJob(input, [], async () => session());
  assert.equal(job.job.id, "uid-1"); assert.equal(job.status, "completed");
  assert.deepEqual(job.nodes.filter(n => n.session).map(n => n.id), ["model-1", "tool-1"]);
  assert.equal(job.relations?.[0]?.target.session?.id, agent.sessionId);
  assert.equal((job.nodes.find(n => n.id.startsWith("assess:")) as Operation).data && input.status.assess![topic.uid]!.executionId, "admitted-run");
  assert.match(String(job.attributes?.attribution), /shared/);
  assert.doesNotThrow(() => inspect(job)); assert.match(renderHTML(job), /quietly checked/);
  assert.deepEqual(inputSessions(input, []), [agent]);
});

test("Failed Output is independent of completed Input; replaced Input UIDs never acquire an old output", async () => {
  const input = fixture(), sent = output(), native = session();
  native.nodes.push({ ...tool, id: "say-node", tool_call_id: "say" } as ToolCall);
  const job = await inputJob(input, [sent], async () => native);
  assert.equal(job.status, "completed"); assert.equal(job.nodes.find(n => n.id === "output:output-1")?.status, "failed");
  assert.equal(job.nodes.filter(n => n.id === model.id).length, 1);
  assert.doesNotThrow(() => inspect(job));
  const replaced = { ...input, metadata: { ...input.metadata, uid: "new-uid" } };
  assert.equal((await inputJob(replaced, [sent], async () => native)).nodes.some(n => n.id.startsWith("output:")), false);
});

test("Missing native Session, unfinished processing and ambiguous tool IDs preserve business facts and expose gaps", async () => {
  const input = fixture();
  const missing = await inputJob(input, [], async () => { throw new Error("Native Pi session is missing"); });
  assert.equal(missing.status, "completed"); assert.match(missing.issues!.join("\n"), /session is missing/);
  assert.ok(missing.nodes.some(n => n.id === `assess:${topic.uid}`));
  const branched = session(); branched.nodes.push({ ...tool, id: "second-branch" } as ToolCall);
  const ambiguous = await inputJob(input, [], async () => branched);
  assert.equal(ambiguous.nodes.some(n => n.kind === "tool_call"), false); assert.match(ambiguous.issues!.join("\n"), /2 native matches/);
  const pending = structuredClone(input); delete pending.status.assess![topic.uid]!.completedAt; delete pending.status.assess![topic.uid]!.completedBy;
  pending.status.assess![topic.uid]!.lastError = "Interrupted";
  const interrupted = await inputJob(pending, [], async () => session());
  assert.equal(interrupted.status, "outcome_unknown"); assert.equal(interrupted.nodes.some(n => n.kind === "model_call"), false);
});

/** @case Output admission timestamps enforce ordering, so a same-ms delivered receipt can precede its logical creation time. */
test("Job preserves Output clock discrepancies as evidence without exporting negative durations", async () => {
  const original = output();
  const sent: Output = { ...original, metadata: { ...original.metadata, creationTimestamp: "2026-10-26T01:00:00.001Z" },
    status: { phase: "delivered", attempts: 0, deliveredAt: at } };
  const job = await inputJob(fixture(), [sent]);
  const delivery = job.nodes.find(n => n.id === "output:output-1") as Operation;
  assert.equal(delivery.status, "completed"); assert.equal(delivery.finished_at, undefined);
  assert.match(JSON.stringify(delivery.data), /2026-10-26T01:00:00.000Z/);
  assert.match(job.issues!.join("\n"), /finish precedes admission/);
  assert.doesNotThrow(() => inspect(job));
});

/** @case Receiving an Input is not evidence that routing has started or completed. */
test("Unrouted Input exports no synthetic route and never completes from an empty receipt list", async () => {
  const input: Input = { ...fixture(), status: {} };
  const job = await inputJob(input, []);
  assert.equal(job.status, "unknown"); assert.equal(job.finished_at, undefined);
  assert.deepEqual(job.nodes.map(n => n.kind), ["input"]);
  assert.match(job.issues!.join("\n"), /No routing receipt/);
  assert.doesNotThrow(() => inspect(job));
  const missingRoute: Input = { ...fixture(), status: { assess: fixture().status.assess } };
  assert.notEqual((await inputJob(missingRoute, [])).status, "completed");
});

test("Assigned assessment remains unknown until its recorded attempt starts", async () => {
  const base = fixture();
  const assigned: Input = { ...base, status: { route: base.status.route,
    assess: { [topic.uid]: { resource: topic, assignedAt: at } } } };
  const waiting = await inputJob(assigned, []);
  assert.equal(waiting.status, "unknown");
  assert.equal(waiting.nodes.find(n => n.id.startsWith("assess:"))!.status, "unknown");
  const active: Input = { ...assigned, status: { ...assigned.status,
    assess: { [topic.uid]: { ...assigned.status.assess![topic.uid]!, startedAt: at, executionId: "started" } } } };
  const running = await inputJob(active, []);
  assert.equal(running.status, "running");
  assert.equal(running.nodes.find(n => n.id.startsWith("assess:"))!.status, "running");
});
