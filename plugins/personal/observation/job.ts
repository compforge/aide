import { inspect, selectNodes, type JobView, type Node, type Operation, type SessionView, type ToolCall, type Input as ObservedInput } from "@compforge/agent-observation";
import type { ReadSession } from "../../../src/observation.ts";
import type { Input } from "../input/state.ts";
import type { Attempt, Handling } from "../input/model.ts";
import type { Output } from "../output/model.ts";
import type { AgentCall } from "./reference.ts";

type Agent = Parameters<ReadSession>[0];
const key = (agent: Agent) => JSON.stringify([agent.harness, agent.sessionId]);
const value = (raw: unknown): NonNullable<Operation["data"]> => JSON.parse(JSON.stringify(raw));
const attempts = (input: Input): [string, Attempt][] => [
  ...(input.status.route ? [["route", input.status.route] as [string, Attempt]] : []),
  ...(input.status.assess ? [["assess", input.status.assess] as [string, Attempt]] : []),
  ...Object.entries(input.status.handle ?? {}).map(([uid, receipt]): [string, Attempt] => [`handle:${uid}`, receipt]),
];
export const associatedOutputs = (input: Input, outputs: readonly Output[]) => outputs.filter(o =>
  o.spec.inputIds?.includes(input.metadata.name) && o.spec.inputUids?.[input.metadata.name] === input.metadata.uid);

/** Only persisted native references authorize a Session read. Names, times and neighboring calls never establish ownership. */
export function inputSessions(input: Input, outputs: readonly Output[]): Agent[] {
  const agents = attempts(input).flatMap(([, r]) => [r.agent, r.completedBy?.agent]);
  agents.push(...associatedOutputs(input, outputs).map(o => o.spec.createdBy?.agent));
  return [...new Map(agents.filter((a): a is Agent => !!a?.sessionId).map(a => [key(a), a])).values()];
}
/** Metadata admission order can be logical (Output adds 1 ms for ties), while delivery uses wall time.
 * Keep conflicting originals in receipt data; an export must not fabricate a negative duration.
 */
function timing(owner: string, start: string | undefined, end: string | undefined, issues: string[]) {
  const result: Pick<Node, "started_at" | "finished_at"> = {};
  for (const [key, value] of [["started_at", start], ["finished_at", end]] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(Date.parse(value)) || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) issues.push(`${owner}: invalid ${key}; retained only in receipt data.`);
    else result[key] = value;
  }
  if (result.started_at && result.finished_at && Date.parse(result.finished_at) < Date.parse(result.started_at)) {
    issues.push(`${owner}: receipt finish precedes admission timestamp; finish retained only in receipt data.`);
    delete result.finished_at;
  }
  return result;
}
function flatten(nodes: readonly Node[]): Node[] {
  return nodes.flatMap(n => [n, ...((n.kind === "turn" || n.kind === "operation") ? flatten((n as Operation).nodes ?? []) : [])]);
}

/**
 * @spec Input UID is the Job ID. Retained business receipts and explicit call references are the evidence boundary.
 * @spec Tool success, Input acknowledgement, Work goal completion and Output delivery are independent facts.
 * @why A continuous Session serves many Inputs. Only referenced tools and their producing model calls enter this Job; costs are not exclusive.
 * @link docs/observation.md
 */
export async function inputJob(input: Input, allOutputs: readonly Output[], read?: ReadSession): Promise<JobView> {
  const outputs = associatedOutputs(input, allOutputs), receipts = attempts(input);
  // @spec Missing routing evidence is waiting/unknown, never a synthetic attempt or vacuous completion.
  const complete = !!input.status.route?.completedAt && receipts.every(([, r]) => !!r.completedAt);
  const active = receipts.some(([, r]) => r.startedAt && !r.completedAt);
  const issues = ["Receipts describe retained current state, not a complete retry history. Native evidence and Outputs may be reclaimed independently."];
  if (!input.status.route) issues.push("No routing receipt recorded; routing has not been observed.");
  const received: ObservedInput = { kind: "input", id: `input:${input.metadata.uid}`, content: value(input.spec), started_at: input.metadata.creationTimestamp };
  const view: JobView = {
    schema_version: "agent-ledger/job@1", job: { source: "aide.input", id: input.metadata.uid },
    name: input.metadata.name, goal: input.spec.text,
    status: complete ? "completed" : receipts.some(([, r]) => r.lastError && !r.completedAt) ? "outcome_unknown" : active ? "running" : "unknown",
    ...timing("job", input.metadata.creationTimestamp, complete ? receipts.map(([, r]) => r.completedAt!).sort().at(-1) : undefined, issues),
    nodes: [received],
    relations: [], attributes: { completion: "Input processing only; not Work goal completion or Output delivery", sessions: value(inputSessions(input, outputs)),
      outputDelivery: value(outputs.map(o => ({ id: o.metadata.name, ...o.status }))),
      attribution: "Model calls can be shared by multiple Inputs; do not sum their cost across Jobs as exclusive cost." },
    issues,
  };
  const calls: { operation: string; call: AgentCall }[] = [];
  for (const [id, receipt] of receipts) {
    const assigned = receipt as Handling;
    const operation: Operation = { kind: "operation", id, operation: `aide.${id.split(":")[0]}`, data: value(receipt),
      ...timing(id, receipt.startedAt ?? assigned.assignedAt, receipt.completedAt, issues),
      status: receipt.completedAt ? (assigned.result?.disposition === "cancelled" ? "cancelled" : "completed") : receipt.lastError ? "outcome_unknown" : receipt.startedAt ? "running" : "unknown",
      evidence: [{ source: "aide.input", id: input.metadata.uid }] };
    view.nodes.push(operation);
    if (receipt.completedBy) calls.push({ operation: id, call: receipt.completedBy });
    else if (receipt.executionId) view.issues!.push(`${id}: no completing tool call recorded; inspect the linked Session for unfinished work.`);
  }
  for (const output of outputs) {
    const id = `output:${output.metadata.uid}`;
    const delivery: Operation = { kind: "operation", id, operation: "aide.output", data: value({ spec: output.spec, status: output.status }),
      ...timing(id, output.metadata.creationTimestamp, output.status.deliveredAt, issues),
      status: output.status.phase === "delivered" ? "completed" : output.status.phase === "failed" ? "failed" : output.status.phase === "uncertain" ? "outcome_unknown" : "running",
      evidence: [{ source: "aide.output", id: output.metadata.uid }] };
    view.nodes.push(delivery);
    if (output.spec.createdBy) calls.push({ operation: id, call: output.spec.createdBy });
  }
  if (allOutputs.some(o => o.spec.inputIds?.includes(input.metadata.name) && !o.spec.inputUids?.[input.metadata.name]))
    view.issues!.push("Outputs without an Input UID were excluded: an input name alone does not prove this incarnation.");
  for (const agent of inputSessions(input, outputs)) {
    let session: SessionView;
    try {
      if (!read) throw new Error("Session reader unavailable");
      session = await read(agent);
      if (session.session.id !== agent.sessionId) throw new Error("Session identity mismatch");
      inspect(session);
    } catch (error) { view.issues!.push(`${agent.harness}/${agent.sessionId}: ${String(error)}`); continue; }
    view.issues!.push(...(session.issues ?? []).map(issue => `${agent.harness}/${agent.sessionId}: ${issue}`));
    const nodes = flatten(session.nodes), selected = new Set<string>();
    for (const { operation, call } of calls.filter(c => key(c.call.agent) === key(agent))) {
      const matches = nodes.filter(n => n.kind === "tool_call" && (n as ToolCall).tool_call_id === call.toolCallId) as ToolCall[];
      if (matches.length !== 1) {
        view.issues!.push(`${operation}: tool ${call.toolCallId} has ${matches.length} native matches; no time/text inference used.`); continue;
      }
      const tool = matches[0]!; selected.add(tool.id);
      if (tool.model_call_id) {
        const models = nodes.filter(n => n.kind === "model_call" && n.id === tool.model_call_id);
        if (models.length === 1) selected.add(models[0]!.id);
        else view.issues!.push(`${operation}: producing model call missing or ambiguous.`);
      }
      view.relations!.push({ kind: "depends_on", source: { id: operation }, target: { id: tool.id, session: session.session } });
    }
    // Multiple role aliases may refer to the same native Session. Keep each source-scoped node once.
    for (const node of selectNodes(session, [...selected])) {
      if (!view.nodes.some(n => n.id === node.id && n.session?.source === node.session?.source && n.session?.id === node.session?.id)) view.nodes.push(node);
    }
  }
  view.issues = [...new Set(view.issues)];
  return view;
}
