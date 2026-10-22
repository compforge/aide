import type { ResourceClient } from "@compforge/aide-plugin";
import { ROUTE_TYPE, type RouteResource, type RouteStatus } from "./model.ts";
/** @spec Concurrent intake and model completion preserve each other's queue changes; stale batches cannot commit. */
export async function updateRoute(resources: ResourceClient, ref: Readonly<RouteResource>, change: (current: Readonly<RouteResource>) => Partial<RouteStatus>) {
  for (let attempt = 0; ; attempt++) {
    const current = await resources.get<Record<string, never>, RouteStatus>({ ...ROUTE_TYPE, ...ref.metadata });
    if (!current || current.metadata.deletionTimestamp) throw new Error("Route incarnation no longer exists");
    const patch = change(current);
    if (!Object.keys(patch).length) return current;
    try { return await resources.patchStatus(current, patch); }
    catch (error) { if (attempt >= 8 || !/version conflict/.test(String(error))) throw error; }
  }
}
export function requireBatch(route: Readonly<RouteResource>, batchId: string) {
  if (route.status.batch?.id !== batchId) throw new Error("Route Batch was superseded");
  return route.status.batch;
}
