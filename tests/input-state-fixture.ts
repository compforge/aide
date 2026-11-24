import type { TopicPolicy } from "../plugins/personal/topic/config.ts";
import { INPUT_TYPE } from "../plugins/personal/input/model.ts";
import type { ResourceClient } from "@compforge/aide-plugin";
import { assessInput } from "../plugins/personal/chief/assess.ts";
import type { TopicResource } from "../plugins/personal/topic/model.ts";
import { deliver, type RoutingInput } from "../plugins/personal/route/delivery.ts";
export async function assessAll(resources: ResourceClient, c: TopicResource, executionId: string, args: { inputIds: string[]; summary: string }, _policy?: TopicPolicy) {
  for (const inputId of args.inputIds) {
    await assessInput(resources, c, executionId, { inputId, summary: args.summary });
  }
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
