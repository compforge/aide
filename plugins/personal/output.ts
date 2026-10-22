import { type Address, type ResourceCommit, type ResourceRef } from "@compforge/aide-plugin";
import { OUTPUT_TYPE, type OutputSpec } from "./output/model.ts";
import type { OutputDraft } from "../../src/output.ts";
import type { ConversationResource } from "./conversation/model.ts";

/** Personal resolves the destination once. Channel delivery never infers it from business identity. */
export function outputSpec(c: Readonly<ConversationResource>, draft: Pick<OutputDraft, "text" | "conversationId" | "target" | "receivers">,
  association: { receivers?: ResourceRef[]; target?: Address; executionId?: string; producer?: ResourceRef; inputIds?: string[] } = {}): OutputSpec {
  if (c.spec.id !== draft.conversationId || c.metadata.deletionTimestamp) throw new Error("Output Conversation is unavailable");
  const { target = draft.target ?? c.spec.address, receivers = draft.receivers, ...provenance } = association;
  if (!target) throw new Error(`Output target required for Conversation: ${c.spec.id}`);
  return { text: draft.text, conversationId: c.spec.id,
    conversation: { apiVersion: c.apiVersion, kind: c.kind, namespace: c.metadata.namespace, name: c.metadata.name, uid: c.metadata.uid },
    target, ...(receivers !== undefined ? { receivers } : {}), ...provenance };
}
export function outputWrite(c: Readonly<ConversationResource>, draft: OutputDraft,
  association: Parameters<typeof outputSpec>[2] = {}): ResourceCommit {
  return { operation: "create", type: OUTPUT_TYPE, name: draft.id, spec: outputSpec(c, draft, association) };
}
