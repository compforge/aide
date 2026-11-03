import { readAgentStream } from "../../../src/stream/agent.ts";
import type { StreamStore } from "../../../src/host/stream/store.ts";
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
  generation?: import("@compforge/aide-plugin").StreamStatus["phase"];
}
export function outputView(output: Readonly<Output>, streams: StreamStore): OutputView {
  const { metadata, spec, status } = output;
  const content = readAgentStream(streams.reader(status.delivery?.stream ?? spec.stream), streams);
  return { role: "aide", id: metadata.name, topicId: spec.topicId, topicUid: spec.topic.uid,
    generation: content.phase, text: content.text, at: metadata.creationTimestamp, target: status.delivery?.target ?? spec.target, receivers: (status.delivery?.receivers ?? spec.receivers)?.toJSON(), workId: spec.producer?.name ?? null,
    executionId: spec.executionId, inputIds: spec.inputIds, status: { ...status, ...(status.delivery ? { delivery: { ...status.delivery, receivers: [...status.delivery.receivers] } } : { delivery: undefined }) }, deliveredAt: status.deliveredAt };
}

/** @spec Every delivery wait reason has a distinct label shared by the timeline and chat projections.
 * @case tests/input-browse.test.ts
 */
export const outputWaitLabels: Record<NonNullable<OutputStatus["deliveryWait"]>["reason"], string> = {
  frequency: "等待投递频控",
  "receiver-busy": "等待接收人的上一条投递完成",
  provider: "等待外部服务允许重试",
};
