import { z } from "zod";
import type { ResourceClient } from "@compforge/aide-plugin";
import { CONVERSATION_TYPE, type ConversationResource, type ConversationSpec, type ConversationStatus } from "./model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";

export const CompleteInputsSchema = z.object({ inputIds: z.array(z.string().min(1)).min(1).max(100), summary: z.string().min(1).max(16000) }).strict();
/** @spec Completion commits the per-input receipts and dequeue atomically; a concurrent arrival is never acknowledged implicitly. */
export async function completeInputs(resources: ResourceClient, owner: Readonly<ConversationResource>, executionId: string,
  raw: unknown, summaryChars = 4000) {
  const { inputIds, summary } = CompleteInputsSchema.parse(raw);
  for (let attempt = 0; ; attempt++) {
    const c = await resources.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, ...owner.metadata });
    if (!c || c.metadata.deletionTimestamp || c.status.execution?.id !== executionId) throw new Error("Chief execution is no longer active");
    const inputs = await Promise.all([...new Set(inputIds)].map(async id => {
      const input = await resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: id });
      if (!input) throw new Error(`Input missing: ${id}`);
      const receipt = input.status.processing?.[c.metadata.uid];
      if (receipt?.phase === "done") return undefined;
      if (!c.status.pendingInputIds.includes(id) || !receipt || (receipt.phase !== "failed" && receipt.executionId !== executionId)) {
        throw new Error(`Input has not been admitted to this Chief: ${id}`);
      }
      return input;
    }));
    const fresh = inputs.filter(i => i !== undefined);
    if (!fresh.length) return { completed: inputIds };
    try {
      await resources.commit([
        ...fresh.map(input => ({ operation: "patchStatus" as const, resource: input, patch: {
          deliveries: [...new Set([...input.status.deliveries ?? [], c.metadata.uid])],
          processing: { ...input.status.processing, [c.metadata.uid]: { executionId, phase: "done", at: new Date().toISOString(), summary } },
        } })),
        { operation: "patchStatus", resource: c, patch: {
          pendingInputIds: c.status.pendingInputIds.filter(id => !inputIds.includes(id)),
          summary: [c.status.summary, summary].filter(Boolean).join("\n").slice(-summaryChars),
        } },
      ]);
      return { completed: inputIds };
    } catch (error) { if (attempt >= 8 || !/version conflict/.test(String(error))) throw error; }
  }
}
