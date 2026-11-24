import { INPUT_TYPE } from "../plugins/personal/input/model.ts";
import type { ResourceClient } from "@compforge/aide-plugin";
import { recordDelivery } from "../plugins/personal/chief/delivery.ts";
import type { TopicResource } from "../plugins/personal/topic/model.ts";
import { deliver, type RoutingInput } from "../plugins/personal/route/delivery.ts";
export async function deliverInput(resources: ResourceClient, c: TopicResource, executionId: string, inputId: string) {
  const input = await admit(resources, inputId, executionId);
  return recordDelivery(resources, c, executionId, input.status.assess?.deliveryId ?? executionId);
}
export async function routeTo(resources: ResourceClient, target: { name: string; uid: string }, input: RoutingInput) {
  const before = await resources.get({ ...input, ...input.metadata });
  await deliver({ resources, logger: { info() {} } }, input, [target], "Fixture assignment");
  return before?.metadata.resourceVersion !== (await resources.get({ ...input, ...input.metadata }))?.metadata.resourceVersion;
}
export async function admit(resources: ResourceClient, inputId: string, executionId: string) {
  const input = await resources.get<import("../plugins/personal/input/model.ts").InputSpec, import("../plugins/personal/input/model.ts").InputStatus>({ ...INPUT_TYPE, name: inputId, namespace: "v1" });
  if (!input) throw new Error(`Input missing: ${inputId}`);
  if (input.status.assess?.completedAt || input.status.assess?.executionId) return input;
  return resources.patchStatus(input, { assess: { ...input.status.assess, executionId, startedAt: new Date().toISOString() } });
}
