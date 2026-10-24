import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "./model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { resourceRef } from "../input/state.ts";
import { WorkInputRequestSchema, type WorkStatus } from "../model.ts";
import { WORK_TYPES, type WorkSpec } from "../resources.ts";
export const AssessInputSchema = z.object({ inputId: z.string().min(1), summary: z.string().min(1).max(1000),
  workRequests: z.array(z.object({ workUid: z.string().min(1), request: WorkInputRequestSchema }).strict()).max(100).default([]) }).strict();
export type AssessInput = z.input<typeof AssessInputSchema>;
/**
 * @spec Finishing Chief assessment and assigning Work handling are atomic; receipts remain on Input.
 * @spec Assessment does not update Topic summary/recent; meaningful understanding is maintained explicitly.
 * @link docs/personal/chief.md
 */
export async function assessInput(resources: ResourceClient, owner: Readonly<TopicResource>, executionId: string, raw: unknown) {
  const args = AssessInputSchema.parse(raw);
  if (new Set(args.workRequests.map(r => r.workUid)).size !== args.workRequests.length) throw new Error("Duplicate Work request");
  for (let n = 0; ; n++) {
    const c = await resources.get<TopicSpec, TopicStatus>({ ...TOPIC_TYPE, ...owner.metadata });
    if (!c || c.metadata.uid !== owner.metadata.uid || c.metadata.deletionTimestamp || c.status.execution?.id !== executionId) throw new Error("Chief execution is no longer active");
    const input = await resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: args.inputId });
    const assessment = input?.status.assess?.[c.metadata.uid];
    if (!input || !assessment) throw new Error("Input does not belong to this Chief");
    if (assessment.completedAt) return { assessed: args.inputId };
    if (!assessment.executionId || (assessment.executionId !== executionId && !assessment.lastError)) throw new Error("Input has not been admitted to this Chief");
    const work = (await Promise.all(WORK_TYPES.map(t => resources.list<WorkSpec, WorkStatus>(t)))).flat();
    const handle = { ...input.status.handle };
    const guards: ResourceCommit[] = [];
    const at = new Date().toISOString();
    for (const { workUid, request } of args.workRequests) {
      const target = work.find(w => w.metadata.uid === workUid && w.spec.topicId === c.spec.id && !w.metadata.deletionTimestamp);
      if (!target) throw new Error(`Work unavailable in this Topic: ${workUid}`);
      if (input.spec.origin === "source" && request.action !== "context") throw new Error("Source facts cannot be control requests");
      const previous = handle[workUid];
      if (previous && !isDeepStrictEqual(previous.request, request)) throw new Error("Input already has a different Work request; submit a new Input");
      handle[workUid] ??= { resource: resourceRef(target), assignedAt: at, request };
      guards.push({ operation: "patchStatus", resource: target, patch: { idleSince: null, agentStoppedAt: null } });
    }
    try {
      await resources.commit([
        ...guards,
        { operation: "patchStatus", resource: input, patch: { handle, assess: { ...input.status.assess, [c.metadata.uid]: {
          ...assessment, completedAt: at, result: { summary: args.summary, disposition: "completed" } } } } },
        // Guard the owning execution/version without turning every receipt into durable topic understanding.
        { operation: "patchStatus", resource: c, patch: {} },
      ]);
      return { assessed: args.inputId, workUids: args.workRequests.map(r => r.workUid) };
    } catch (e) { if (n >= 8 || !/version conflict/.test(String(e))) throw e; }
  }
}
