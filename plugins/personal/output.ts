import type { MailDraft, NoteCitation } from "./stream/writer.ts";
import { PersonRefsSchema } from "./person/model.ts";
import { type Address, type ResourceCommit, type ResourceRef } from "@compforge/aide-plugin";
import { OUTPUT_TYPE, type OutputSpec } from "./output/model.ts";
import type { OutputDraft } from "./output/view.ts";
import type { TopicResource } from "./topic/model.ts";

/** Personal resolves the destination once. Channel delivery never infers it from business identity. */
export function mailDraft(c: Readonly<TopicResource>, draft: Pick<OutputDraft, "text" | "topicId" | "target" | "receivers">,
  association: { conversation?: OutputSpec["conversation"]; handoffId?: string; contentKind?: "agent"; replyToMessageId?: string; replyTo?: OutputSpec["replyTo"]; receivers?: ResourceRef[]; target?: Address; executionId?: string; producer?: ResourceRef; inputIds?: string[]; inputUids?: Record<string, string>; notes?: readonly NoteCitation[]; createdBy?: OutputSpec["createdBy"] } = {}): MailDraft {
  if (c.spec.id !== draft.topicId || c.metadata.deletionTimestamp) throw new Error("Output Topic is unavailable");
  const { target = draft.target ?? c.spec.address, receivers = draft.receivers, contentKind, notes, ...provenance } = association;
  if (!target) throw new Error(`Output target required for Topic: ${c.spec.id}`);
  return { content: contentKind === "agent" ? { kind: "agent" } : { kind: "text", text: draft.text, ...(notes ? { notes } : {}) }, topicId: c.spec.id,
    topic: { apiVersion: c.apiVersion, kind: c.kind, namespace: c.metadata.namespace, name: c.metadata.name, uid: c.metadata.uid },
    target, ...(receivers !== undefined ? { receivers: PersonRefsSchema().parse(receivers) } : {}), ...provenance };
}
export function outputWrite(c: Readonly<TopicResource>, draft: OutputDraft,
  association: Parameters<typeof mailDraft>[2] = {}): ResourceCommit {
  return { operation: "create", type: OUTPUT_TYPE, name: draft.id, spec: mailDraft(c, draft, association) };
}
