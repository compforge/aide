import { routePrompt } from "./prompt.ts";
import { randomUUID } from "node:crypto";
import type { PluginContext, Watch } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { CONVERSATION_TYPE, type ConversationSpec, type ConversationStatus } from "../conversation/model.ts";
import { ROUTE_NAME, ROUTE_TYPE, type RouteResource } from "./model.ts";
import { routePolicy } from "./config.ts";
import { routeByRules } from "./rules.ts";
import { routed, type RoutingInput } from "./delivery.ts";
import { updateRoute } from "./state.ts";
import { reconcileRouteBatch } from "./batch.ts";

const request = () => [{ name: ROUTE_NAME, namespace: "v1" as const }];
function routeWatch(changed: (a: Readonly<RouteResource>, b: Readonly<RouteResource>) => boolean): Watch {
  return { resourceType: ROUTE_TYPE, handler: { create: async () => [], delete: async () => [],
    update: async ({ oldObject, newObject }) => changed(oldObject as RouteResource, newObject as RouteResource) ? request() : [] } };
}
export function registerRoute(context: PluginContext): void {
  context.controllers.register({ resourceType: ROUTE_TYPE, maxConcurrency: 1,
    sources: [{ type: "resource", sourceId: "global", async start(source) { await source.emit({ name: ROUTE_NAME, spec: {} }); } }],
    watches: [
      { resourceType: INPUT_TYPE, handler: { create: async () => request(), delete: async () => [],
        update: async ({ oldObject, newObject }) => !routed(oldObject as RoutingInput) && routed(newObject as RoutingInput) ? request() : [] } },
      routeWatch((a, b) => a.status.batch?.id !== b.status.batch?.id),
    ],
    reconcile: (_execution, route: Readonly<RouteResource>) => reconcileRoute(context, route),
  });
  context.controllers.register({ resourceType: ROUTE_TYPE, name: "batch", maxConcurrency: 1,
    watches: [routeWatch((a, b) => a.status.batch?.id !== b.status.batch?.id)],
    reconcile: (execution, route: Readonly<RouteResource>) => reconcileRouteBatch(context, execution, route),
  });
}

/** @spec Watches only wake Route. Durable Input discovery repairs a missed event or crash before enqueue.
 * @spec Model waits run on a separate controller so deterministic delivery remains independent.
 */
export async function reconcileRoute(context: PluginContext, initial: Readonly<RouteResource>) {
  if (initial.metadata.deletionTimestamp) return;
  const policy = routePolicy(context.instance.config.route);
  const inputs = (await context.resources.list<InputSpec, InputStatus>(INPUT_TYPE)).filter(i => !routed(i) && !i.metadata.deletionTimestamp)
    .sort((a, b) => a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp) || a.metadata.name.localeCompare(b.metadata.name));
  let route = await updateRoute(context.resources, initial, current => {
    const ids = [...new Set([...current.status.pendingInputIds, ...inputs.map(i => i.metadata.name)])];
    return ids.length === current.status.pendingInputIds.length ? {} : { pendingInputIds: ids };
  });
  const active = new Set(route.status.batch?.inputIds ?? []);
  const completed = new Set<string>();
  let retry = false;
  const blocked = new Set<string>();
  for (const id of route.status.pendingInputIds) {
    if (active.has(id)) continue;
    const input = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: id });
    if (!input) throw new Error(`Route pending Input missing: ${id}`);
    try { if (await routeByRules(context, input)) completed.add(id); }
    catch (error) {
      retry = true; blocked.add(id);
      context.logger.error("Route deterministic delivery failed; retained Input", { error, attributes: { inputId: id } });
    }
  }
  route = await updateRoute(context.resources, route, current => completed.size
    ? { pendingInputIds: current.status.pendingInputIds.filter(id => !completed.has(id)) } : {});
  if (route.status.batch) return retry ? { requeueAfterMs: 1000 } : undefined;
  const pending = [];
  for (const id of route.status.pendingInputIds) {
    const input = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: id });
    if (blocked.has(id) || !input || routed(input) || input.status.routing?.destinations) continue;
    const originalId = input.spec.observation?.originalInputId;
    if (typeof originalId === "string" && originalId !== id) {
      const preceding = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: originalId });
      if (preceding && !routed(preceding)) continue;
    }
    pending.push(input);
  }
  if (!pending.length) return retry ? { requeueAfterMs: 1000 } : undefined;
  const deadline = Date.parse(pending[0]!.metadata.creationTimestamp) + policy.maxWaitSeconds * 1000;
  const immediate = pending.some(i => (i.spec.attention ?? (i.spec.origin === "channel" ? "immediate" : "deferred")) === "immediate");
  if (!immediate && pending.length < policy.batchSize && Date.now() < deadline) return { requeueAfterMs: Math.min(retry ? 1000 : Infinity, Math.max(1, deadline - Date.now())) };
  const conversations = await context.resources.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE);
  const snapshot = routePrompt(pending, conversations, policy);
  route = await updateRoute(context.resources, route, current => current.status.batch ? {} : { batch: {
    id: randomUUID(), ...snapshot, createdAt: new Date().toISOString(), phase: "queued",
  } });
  context.logger.info("Route Batch queued", { attributes: { batchId: route.status.batch!.id, inputCount: snapshot.inputIds.length, conversationCount: snapshot.candidates.length } });
  return retry ? { requeueAfterMs: 1000 } : undefined;
}
