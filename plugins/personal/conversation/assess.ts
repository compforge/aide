import { SUMMARY_CHARS } from "../context.ts";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { CONVERSATION_TYPE, type ConversationResource, type ConversationSpec, type ConversationStatus } from "./model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { resourceRef } from "../input/state.ts";
import { WorkInputRequestSchema, type WorkStatus } from "../model.ts";
import { WORK_TYPES, type WorkSpec } from "../resources.ts";
export const AssessInputSchema = z.object({ inputId: z.string().min(1), summary: z.string().min(1).max(16000),
  conversationSummary: z.string().max(SUMMARY_CHARS),
  workRequests: z.array(z.object({ workUid: z.string().min(1), request: WorkInputRequestSchema }).strict()).max(100).default([]) }).strict();
export type AssessInput = z.input<typeof AssessInputSchema>;
/** @spec Finishing Chief assessment and assigning Work handling are atomic; no tool reply or model turn can stand in for this receipt. */
export async function assessInput(resources: ResourceClient, owner: Readonly<ConversationResource>, executionId: string, raw: unknown, summaryChars = 4000) {
  const args = AssessInputSchema.parse(raw);
  if (args.conversationSummary.length > summaryChars) throw new Error(`Conversation summary exceeds ${summaryChars} characters; condense and retry`);
  let previousSummary: string | undefined;
  if (new Set(args.workRequests.map(r => r.workUid)).size !== args.workRequests.length) throw new Error("Duplicate Work request");
  for (let n = 0; ; n++) {
    const c = await resources.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, ...owner.metadata });
    if (!c || c.metadata.deletionTimestamp || c.status.execution?.id !== executionId) throw new Error("Chief execution is no longer active");
    const input = await resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: args.inputId });
    const assessment = input?.status.assess?.[c.metadata.uid];
    if (!input || !assessment) throw new Error("Input does not belong to this Chief");
    if (assessment.completedAt) return { assessed: args.inputId };
    if (!assessment.executionId || (assessment.executionId !== executionId && !assessment.lastError)) throw new Error("Input has not been admitted to this Chief");
    if (previousSummary !== undefined && previousSummary !== c.status.summary) throw new Error("Conversation summary changed; read the current context and merge before retrying");
    previousSummary = c.status.summary;
    const work = (await Promise.all(WORK_TYPES.map(t => resources.list<WorkSpec, WorkStatus>(t)))).flat();
    const handle = { ...input.status.handle };
    const guards: ResourceCommit[] = [];
    const at = new Date().toISOString();
    for (const { workUid, request } of args.workRequests) {
      const target = work.find(w => w.metadata.uid === workUid && w.spec.conversationId === c.spec.id && !w.metadata.deletionTimestamp);
      if (!target) throw new Error(`Work unavailable in this Conversation: ${workUid}`);
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
        { operation: "patchStatus", resource: c, patch: { summary: args.conversationSummary, recent: [...c.status.recent, { at, text: args.summary }] } },
      ]);
      return { assessed: args.inputId, workUids: args.workRequests.map(r => r.workUid) };
    } catch (e) { if (n >= 8 || !/version conflict/.test(String(e))) throw e; }
  }
}
