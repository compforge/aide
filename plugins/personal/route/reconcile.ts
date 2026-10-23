import type { PluginContext, ReconcileContext, Watch } from "@compforge/aide-plugin";
import { INPUT_TYPE } from "../input/model.ts";
import { pendingInputs, resourceRef } from "../input/state.ts";
import { ROUTE_NAME, ROUTE_TYPE, ROUTE_TARGET, type RouteResource } from "./model.ts";
import { routeByRules, defaultDestination } from "./rules.ts";
import { routed, deliver, type RoutingInput } from "./delivery.ts";
import { finalizeExecution, nextInput, retryDelay, runInput, steerPending } from "../loop.ts";
import { inputPrinter } from "../input/printer.ts";
import { routePolicy } from "./config.ts";
import { CONVERSATION_TYPE } from "../conversation/model.ts";
const request = () => [{ name: ROUTE_NAME, namespace: "v1" as const }];
function watches(): Watch[] {
  return [{ resourceType: INPUT_TYPE, handler: { create: async () => request(), delete: async () => [],
    update: async ({ oldObject, newObject }) => JSON.stringify((oldObject as RoutingInput).status.route) !== JSON.stringify((newObject as RoutingInput).status.route) ? request() : [] } },
    { resourceType: ROUTE_TYPE, handler: { create: async () => [], delete: async () => [], update: async ({ oldObject, newObject }) =>
      (oldObject as RouteResource).status.execution?.id !== (newObject as RouteResource).status.execution?.id ? request() : [] } }];
}
export function registerRoute(context: PluginContext): void {
  context.controllers.register({ resourceType: ROUTE_TYPE, maxConcurrency: 1,
    sources: [{ type: "resource", sourceId: "global", async start(source) { await source.emit({ name: ROUTE_NAME, spec: {} }); } }], watches: watches(),
    reconcile: (execution, route: Readonly<RouteResource>) => reconcileRoute(context, route, execution) });
  context.controllers.register({ resourceType: ROUTE_TYPE, name: "agent", maxConcurrency: 1, watches: watches(),
    reconcile: (execution, route: Readonly<RouteResource>) => reconcileRouteAgent(context, execution, route) });
}
/** Deterministic rules remain available while the persistent Route agent is busy. */
export async function reconcileRoute(context: PluginContext, route: Readonly<RouteResource>, execution?: ReconcileContext) {
  if (route.metadata.deletionTimestamp) return;
  let failed = false;
  for (const input of await pendingInputs(context.resources, resourceRef(route))) {
    if (input.metadata.deletionTimestamp || input.status.route?.executionId) continue;
    try { await routeByRules(context, input); }
    catch (error) { failed = true; context.logger.error("Rule routing failed; Input retained", { attributes: { inputId: input.metadata.name, error: String(error) } }); }
  }
  return (execution ? await steerPending(context, execution, route) : undefined) ?? (failed ? { requeueAfterMs: 30_000 } : undefined);
}
export async function reconcileRouteAgent(context: PluginContext, execution: ReconcileContext, route: Readonly<RouteResource>) {
  if (route.metadata.deletionTimestamp) return;
  if (route.status.execution) { await finalizeExecution(context, route, route.status.execution.id); return { requeueAfterMs: 1 }; }
  const input = await nextInput(context.resources, route);
  if (!input) return retryDelay(context.resources, route);
  if (routed(input)) return;
  if (await routeByRules(context, input)) return { requeueAfterMs: 1 };
  if (!(await context.resources.list(CONVERSATION_TYPE)).some(c => !c.metadata.deletionTimestamp)) {
    await deliver(context, input, [await defaultDestination(context)], "No existing Conversation"); return { requeueAfterMs: 1 };
  }
  const prompt = `Route this input. Read the current Conversation catalog with list_conversations; use route_input to commit its destinations. Earlier context may be stale.\n${JSON.stringify({ inputId: input.metadata.name })}\n${inputPrinter.describe(input).slice(0, routePolicy(context.instance.config.route).contextChars)}\nUse read_input for complete evidence.`;
  await runInput(context, execution.withContext({ inputId: input.metadata.name }), route, ROUTE_TARGET, prompt, input.metadata.name);
  return { requeueAfterMs: 1 };
}
