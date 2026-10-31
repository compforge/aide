import type { Address, ResourceRef } from "@compforge/aide-plugin";
import type { Output, OutputStatus } from "./model.ts";
export interface OutputDraft { id: string; topicId: string; text: string; workId: string | null; target?: Address; receivers?: ResourceRef[] }
export interface OutputView extends OutputDraft {
  at: string;
  role: "aide";
  topicUid: string;
  target: Address;
  executionId?: string;
  inputIds?: string[];
  status: Omit<OutputStatus, "delivery"> & { delivery?: Omit<NonNullable<OutputStatus["delivery"]>, "receivers"> & { receivers: ResourceRef[] } };
  deliveredAt?: string;
}
export function outputView(output: Readonly<Output>): OutputView {
  const { metadata, spec, status } = output;
  return { role: "aide", id: metadata.name, topicId: spec.topicId, topicUid: spec.topic.uid,
    text: status.delivery?.text ?? spec.text, at: metadata.creationTimestamp, target: status.delivery?.target ?? spec.target, receivers: (status.delivery?.receivers ?? spec.receivers)?.toJSON(), workId: spec.producer?.name ?? null,
    executionId: spec.executionId, inputIds: spec.inputIds, status: { ...status, ...(status.delivery ? { delivery: { ...status.delivery, receivers: [...status.delivery.receivers] } } : { delivery: undefined }) }, deliveredAt: status.deliveredAt };
}
