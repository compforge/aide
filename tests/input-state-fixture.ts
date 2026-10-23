import type { ResourceClient, ResourceRef } from "@compforge/aide-plugin";
import { assessInput } from "../plugins/personal/conversation/assess.ts";
import type { ConversationResource } from "../plugins/personal/conversation/model.ts";
import { deliver, type RoutingInput } from "../plugins/personal/route/delivery.ts";
import { changeAttempt, resourceRef } from "../plugins/personal/input/state.ts";
export async function assessAll(resources: ResourceClient, c: ConversationResource, executionId: string, args: { inputIds: string[]; summary: string }) {
  for (const inputId of args.inputIds) await assessInput(resources, c, executionId, { inputId, conversationSummary: args.summary.slice(0, 4000), summary: args.summary });
}
export async function routeTo(resources: ResourceClient, target: { name: string; uid: string }, input: RoutingInput) {
  const before = await resources.get({ ...input, ...input.metadata });
  await deliver({ resources, logger: { info() {} } }, input, [target], "Fixture assignment");
  return before?.metadata.resourceVersion !== (await resources.get({ ...input, ...input.metadata }))?.metadata.resourceVersion;
}
export async function admit(resources: ResourceClient, inputId: string, uid: string, executionId: string) {
  const c = (await resources.list({ apiVersion: "aide.dev/v1alpha1", kind: "Conversation" })).find(c => c.metadata.uid === uid)!;
  return changeAttempt(resources, inputId, resourceRef(c), () => ({ executionId, startedAt: new Date().toISOString() }));
}

export async function handoff(store: import("../plugins/personal/conversation/store.ts").ConversationStore, resources: ResourceClient, inputId: string, requests: import("../plugins/personal/conversation/assess.ts").AssessInput["workRequests"], summary = "Handed to Work") {
  const c = store.resource("me")!;
  const executionId = c.status.execution?.id ?? "fixture";
  if (!c.status.execution) await resources.patchStatus(c, { execution: { id: executionId, startedAt: new Date().toISOString() } });
  await admit(resources, inputId, c.metadata.uid, executionId);
  return assessInput(resources, c, executionId, { inputId, summary, conversationSummary: summary.slice(0, 4000), workRequests: requests });
}
