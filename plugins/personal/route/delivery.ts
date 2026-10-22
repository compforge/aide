import type { PluginContext, Resource } from "@compforge/aide-plugin";
import { appendConversationInput } from "../conversation/input.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import type { Destination } from "./model.ts";
export type RoutingContext = Pick<PluginContext, "resources" | "logger">;
export type RoutingInput = Readonly<Resource<InputSpec, InputStatus>>;
export const routed = (input: RoutingInput) => ["done", "ignored"].includes(input.status.routing?.phase ?? "");
/** @spec Persist the complete UID-pinned plan before delivery. Receipts make partial fanout safe to resume. */
export async function deliver(context: RoutingContext, original: RoutingInput, destinations: Destination[], reason: string) {
  const ref = { ...INPUT_TYPE, ...original.metadata };
  let input = (await context.resources.get<InputSpec, InputStatus>(ref))!;
  if (routed(input)) return;
  if (!input.status.routing?.destinations) input = await context.resources.patchStatus(input, {
    routing: { ...input.status.routing, phase: "running", reason, destinations },
  });
  for (const target of input.status.routing!.destinations!) {
    if (await appendConversationInput(context.resources, target, input)) context.logger.info("Route delivered Input", {
      attributes: { inputId: input.metadata.name, conversationUid: target.uid, conversationName: target.name } });
  }
  input = (await context.resources.get<InputSpec, InputStatus>(ref))!;
  await context.resources.patchStatus(input, { routing: { ...input.status.routing!, phase: "done" } });
}
