import type { Output, Address, OutputStatus, ResourceRef } from "@compforge/aide-plugin";
export interface OutputDraft { id: string; conversationId: string; text: string; workId: string | null; target?: Address; receivers?: ResourceRef[] }
export interface OutputView extends OutputDraft {
  at: string;
  role: "aide";
  conversationUid: string;
  target: Address;
  executionId?: string;
  inputIds?: string[];
  status: OutputStatus;
  deliveredAt?: string;
}
export function outputView(output: Readonly<Output>): OutputView {
  const { metadata, spec, status } = output;
  return { role: "aide", id: metadata.name, conversationId: spec.conversationId, conversationUid: spec.conversation.uid,
    text: spec.text, at: metadata.creationTimestamp, target: spec.target, receivers: spec.receivers, workId: spec.producer?.name ?? null,
    executionId: spec.executionId, inputIds: spec.inputIds, status, deliveredAt: status.deliveredAt };
}
