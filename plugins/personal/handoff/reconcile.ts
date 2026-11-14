import { equalResourceValue } from "../../../src/resource/value.ts";
import type { PluginContext } from "@compforge/aide-plugin";
import { HANDOFF_TYPE, HandoffStatusSchema, type Handoff, type HandoffSpec, type HandoffStatus } from "./model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { patchStatus } from "../status.ts";

/** @spec Input admission receipts update handoff tracking, never infer business completion or wake Gate from an Output.
 * @link docs/personal/gate.md
 */
export async function reconcileHandoff(context: Pick<PluginContext, "resources">, handoff: Readonly<Handoff>) {
  const input = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: handoff.status.latestInputId });
  if (!input || input.metadata.deletionTimestamp) {
    if (handoff.status.phase === "submitted") await patchStatus(context.resources, handoff, { phase: "failed", report: "Delegated Input expired before acceptance", updatedAt: new Date().toISOString() });
    return;
  }
  const phase = handoff.status.phase === "submitted" && input.status.assess?.startedAt ? "accepted" : handoff.status.phase;
  const works = [...new Map([...handoff.status.works, ...Object.values(input.status.handle ?? {}).map(h => h.resource)].map(w => [w.uid, w])).values()];
  const patch = HandoffStatusSchema.partial().parse({ topic: input.status.topic, phase, works, receivedAt: handoff.status.receivedAt ?? input.status.assess?.startedAt });
  if (equalResourceValue({ topic: handoff.status.topic, phase: handoff.status.phase, works: handoff.status.works, receivedAt: handoff.status.receivedAt }, patch)) return;
  await patchStatus(context.resources, handoff, { ...patch, updatedAt: new Date().toISOString() });
}
export function registerHandoffs(context: PluginContext) {
  const requests = (input: { spec: unknown }) => {
    const handoff = (input.spec as InputSpec).handoff;
    return handoff ? [{ name: handoff.id, namespace: "v1" as const }] : [];
  };
  context.controllers.register<HandoffSpec, HandoffStatus>({ resourceType: HANDOFF_TYPE,
    watches: [{ resourceType: INPUT_TYPE, handler: { create: async e => requests(e.object), update: async e => requests(e.newObject), delete: async e => requests(e.object) } }],
    reconcile: async (_execution, handoff) => reconcileHandoff(context, handoff) });
}
