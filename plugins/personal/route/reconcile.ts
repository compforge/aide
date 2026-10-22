import type { PluginContext, ReconcileContext, Watch } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { ROUTE_NAME, ROUTE_TYPE, ROUTE_TARGET, type RouteResource } from "./model.ts";
import { routeByRules, defaultDestination } from "./rules.ts";
import { routed, deliver, type RoutingInput } from "./delivery.ts";
import { updateRoute } from "./state.ts";
import { nextInput, processing, runInput, steerPending } from "../loop.ts";
import { inputPrinter } from "../input/printer.ts";
import { routePolicy } from "./config.ts";
import { CONVERSATION_TYPE } from "../conversation/model.ts";

const request = () => [{ name: ROUTE_NAME, namespace: "v1" as const }];
function routeWatch(): Watch {
  return { resourceType: ROUTE_TYPE, handler: { create: async () => [], delete: async () => [],
    update: async ({ oldObject, newObject }) => {
      const a = oldObject as RouteResource, b = newObject as RouteResource;
      return JSON.stringify(a.status.pendingInputIds) !== JSON.stringify(b.status.pendingInputIds) || a.status.execution?.id !== b.status.execution?.id ? request() : [];
    } } };
}
export function registerRoute(context: PluginContext): void {
  context.controllers.register({ resourceType: ROUTE_TYPE, maxConcurrency: 1,
    sources: [{ type: "resource", sourceId: "global", async start(source) { await source.emit({ name: ROUTE_NAME, spec: {} }); } }],
    watches: [{ resourceType: INPUT_TYPE, handler: { create: async () => request(), delete: async () => [],
      update: async ({ oldObject, newObject }) => !routed(oldObject as RoutingInput) && routed(newObject as RoutingInput) ? request() : [] } }, routeWatch()],
    reconcile: (execution, route: Readonly<RouteResource>) => reconcileRoute(context, route, execution),
  });
  context.controllers.register({ resourceType: ROUTE_TYPE, name: "agent", maxConcurrency: 1, watches: [routeWatch()],
    reconcile: (execution, route: Readonly<RouteResource>) => reconcileRouteAgent(context, execution, route) });
}

/** @spec Durable discovery repairs missed wakes; rule delivery and a saved plan do not wait for the model. */
export async function reconcileRoute(context: PluginContext, initial: Readonly<RouteResource>, execution?: ReconcileContext) {
  if (initial.metadata.deletionTimestamp) return;
  const inputs = (await context.resources.list<InputSpec, InputStatus>(INPUT_TYPE)).filter(i => !routed(i) && !i.metadata.deletionTimestamp);
  let route = await updateRoute(context.resources, initial, current => ({ pendingInputIds: [...new Set([...current.status.pendingInputIds, ...inputs.map(i => i.metadata.name)])] }));
  const completed = new Set<string>();
  let failed = false;
  for (const id of route.status.pendingInputIds) {
    const input = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: id });
    if (!input) throw new Error(`Route pending Input missing: ${id}`);
    if (routed(input)) {
      if (input.status.processing?.[route.metadata.uid]) await processing(context.resources, id, route.metadata.uid, p => p && p.phase !== "done"
        ? { executionId: p.executionId, phase: "done", at: new Date().toISOString(), summary: input.status.routing!.reason } : p);
      completed.add(id); continue;
    }
    // Once offered to Route, its decision owns this input. Persisted decisions can always finish delivery.
    if (!input.status.routing?.destinations && input.status.processing?.[route.metadata.uid]) continue;
    try { if (await routeByRules(context, input)) completed.add(id); }
    catch (error) {
      failed = true;
      context.logger.error("Route delivery retained for retry", { attributes: { inputId: id, error: String(error) } });
    }
  }
  route = await updateRoute(context.resources, route, current => completed.size ? { pendingInputIds: current.status.pendingInputIds.filter(id => !completed.has(id)) } : {});
  const steering = execution ? await steerPending(context, execution, route) : undefined;
  return steering ?? (failed ? { requeueAfterMs: 30_000 } : undefined);
}

export async function reconcileRouteAgent(context: PluginContext, execution: ReconcileContext, route: Readonly<RouteResource>) {
  if (route.metadata.deletionTimestamp || route.status.execution) return;
  const input = await nextInput(context.resources, route);
  if (!input) {
    // Classification has no external effects. Saved fanout plans are resumed by the intake controller.
    for (const id of route.status.pendingInputIds) await processing(context.resources, id, route.metadata.uid, p => p?.phase === "failed" ? undefined : p);
    return route.status.pendingInputIds.length ? { requeueAfterMs: 30_000 } : undefined;
  }
  if (routed(input)) return;
  const originalId = input.spec.observation?.originalInputId;
  if (typeof originalId === "string" && originalId !== input.metadata.name) {
    const preceding = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: originalId });
    if (preceding && !routed(preceding)) return { requeueAfterMs: 1000 };
  }
  if (await routeByRules(context, input)) return { requeueAfterMs: 1 };
  if (!(await context.resources.list(CONVERSATION_TYPE)).some(c => !c.metadata.deletionTimestamp)) {
    await deliver(context, input, [await defaultDestination(context)], "No existing Conversation");
    return { requeueAfterMs: 1 };
  }
  const prompt = `Route this input. Read the current Conversation catalog with list_conversations; use route_input to commit its destinations. Earlier context may be stale.\n${JSON.stringify({ inputId: input.metadata.name })}\n${inputPrinter.describe(input).slice(0, routePolicy(context.instance.config.route).contextChars)}\nUse read_input for complete evidence.`;
  await runInput(context, execution.withContext({ inputId: input.metadata.name }), route, ROUTE_TARGET, prompt, input.metadata.name);
  return { requeueAfterMs: 1 };
}
