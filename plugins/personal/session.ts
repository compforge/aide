import { patchStatus } from "./status.ts";
import { z } from "zod";
import type { AgentStatus, ReconcileContext, ResourceClient } from "@compforge/aide-plugin";
import type { LoopResource, LoopStatus } from "./loop.ts";
import { resourceRef } from "./input/state.ts";

/** Native binding only; history and checkpoints remain owned by the Harness. */
export const AgentStatusSchema = z.object({
  harness: z.string().min(1),
  sessionId: z.string().min(1).optional(),
}).strict();

/** @spec Personal owns its status layout. Saving a recovery reference never repeats Harness effects. */
export async function saveAgent(resources: ResourceClient, owner: Readonly<LoopResource>, executionId: string, agent: AgentStatus): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const current = await resources.get<unknown, LoopStatus>(resourceRef(owner));
    if (!current || current.metadata.uid !== owner.metadata.uid || current.metadata.deletionTimestamp || current.status.execution?.id !== executionId) throw new Error("Agent owner is no longer active");
    try { await patchStatus(resources, current, { agent }); return; }
    catch (error) { if (attempt >= 8 || !String(error).includes("version conflict")) throw error; }
  }
}

/** Persist the native identity before admitting business effects in a long-running loop. */
export async function prepareAgent(resources: ResourceClient, execution: ReconcileContext, owner: Readonly<LoopResource>, harness: string): Promise<AgentStatus> {
  if (owner.status.agent?.harness === harness && owner.status.agent.sessionId) return owner.status.agent;
  const created = await execution.verbs.harness({ operation: "create", harness, timeoutMs: 30_000 });
  if (created.state !== "success" || created.value.outcome !== "accepted" || !created.agent?.sessionId) throw new Error("Continuous agent requires a native recovery reference before prompt");
  try { await saveAgent(resources, owner, execution.executionId, created.agent); }
  catch (error) {
    await execution.verbs.harness({ operation: "close", harness, sessionId: created.agent.sessionId, timeoutMs: 30_000 });
    throw error;
  }
  return created.agent;
}
