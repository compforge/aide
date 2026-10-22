import { z } from "zod";
import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { type RouteBatch, type RouteResource, type RouteDecision, ROUTE_TARGET } from "./model.ts";
import { updateRoute, requireBatch } from "./state.ts";
import { deliver } from "./delivery.ts";
import { defaultDestination } from "./rules.ts";

const Answer = z.object({ decisions: z.array(z.object({ inputId: z.string(), conversationUids: z.array(z.string()), reason: z.string() }).strict()) }).strict();
/** @spec A model can choose only snapshotted Input and Conversation identities, once per Input. No omitted Input is acknowledged. */
export function parseRoutePlan(text: string, batch: RouteBatch): RouteDecision[] {
  const answer = Answer.parse(JSON.parse(text));
  const seen = new Set<string>();
  const plan = answer.decisions.map(d => {
    if (!batch.inputIds.includes(d.inputId) || seen.has(d.inputId)) throw new Error("Route decision contains an unknown or duplicate Input");
    seen.add(d.inputId);
    const destinations = [...new Set(d.conversationUids)].map(uid => {
      const c = batch.candidates.find(c => c.uid === uid);
      if (!c) throw new Error(`Route decision references an unknown Conversation: ${uid}`);
      return { name: c.name, uid };
    });
    return { inputId: d.inputId, destinations, reason: d.reason };
  });
  if (seen.size !== batch.inputIds.length) throw new Error("Route decision omitted an Input");
  return plan;
}

/** @spec Persist the whole plan before appending. Restart retries only side-effect-free judgment or remaining idempotent deliveries.
 * @link tests/route.test.ts
 */
export async function reconcileRouteBatch(context: PluginContext, execution: ReconcileContext, initial: Readonly<RouteResource>) {
  if (initial.metadata.deletionTimestamp || !initial.status.batch) return;
  let route = initial;
  let batch = initial.status.batch;
  const batchId = batch.id;
  if (batch.phase !== "planned") {
    route = await updateRoute(context.resources, route, current => ({ batch: { ...requireBatch(current, batchId), phase: "running" } }));
    batch = route.status.batch!;
    let plan: RouteDecision[];
    if (!batch.candidates.length) plan = batch.inputIds.map(inputId => ({ inputId, destinations: [], reason: "No existing Conversation" }));
    else {
      const response = await execution.verbs.harness({ harnessTargetId: ROUTE_TARGET, title: "Route inputs", prompt: batch.prompt, freshContext: true, timeoutMs: 120_000 });
      if (response.state !== "success" || response.value.outcome !== "completed" || response.value.result.stopReason !== "end_turn") throw new Error("Route Agent did not complete; retained Batch for retry");
      plan = parseRoutePlan(response.value.result.finalText ?? "", batch);
    }
    if (plan.some(d => !d.destinations.length)) {
      const fallback = await defaultDestination(context);
      plan = plan.map(d => d.destinations.length ? d : { ...d, destinations: [fallback] });
    }
    route = await updateRoute(context.resources, route, current => ({ batch: { ...requireBatch(current, batchId), phase: "planned", plan } }));
    context.logger.info("Route plan persisted", { attributes: { batchId, inputCount: plan.length, deliveries: plan.reduce((n, d) => n + d.destinations.length, 0) } });
  }
  batch = requireBatch(route, batchId);
  if (!batch.plan) throw new Error("Planned Route Batch has no plan");
  for (const decision of batch.plan) {
    const input = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: decision.inputId });
    if (!input) throw new Error(`Route Batch Input missing: ${decision.inputId}`);
    await deliver(context, input, decision.destinations, decision.reason);
  }
  await updateRoute(context.resources, route, current => {
    const done = new Set(requireBatch(current, batchId).inputIds);
    return { batch: null, pendingInputIds: current.status.pendingInputIds.filter(id => !done.has(id)) };
  });
  context.logger.info("Route Batch delivered and dequeued", { attributes: { batchId, inputCount: batch.inputIds.length } });
}
