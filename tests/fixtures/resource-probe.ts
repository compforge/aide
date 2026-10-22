import type { ResourceType } from "@compforge/aide-plugin";
import type { Manager } from "../../src/host/plugin/manager.ts";

let sequence = 0;
/** Drive fixture behavior through the same durable resource path as a real Operator. */
export async function runProbe<T = unknown>(manager: Manager, instance: string, type: ResourceType, operation: string, input?: unknown): Promise<T> {
  const client = manager.resourceClient(instance);
  const resource = await client.create(type, { name: `probe-${++sequence}`, spec: { operation, ...(input === undefined ? {} : { input }) } });
  const ref = { ...type, name: resource.metadata.name, namespace: resource.metadata.namespace, uid: resource.metadata.uid };
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const current = await client.get<unknown, { done?: boolean; result?: T; error?: string }>(ref);
    if (current?.status.error) throw new Error(current.status.error);
    if (current?.status.done) return current.status.result as T;
    if (!manager.isInstanceActive(instance)) throw new Error("Plugin Runner stopped before the probe completed");
    await Bun.sleep(5);
  }
  throw new Error(`Resource probe did not finish: ${operation}`);
}
