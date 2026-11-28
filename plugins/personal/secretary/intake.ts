import type { ResourceReader } from "@compforge/aide-plugin";
import { deliveryRetryDue, compareInputPriority, InputAttention, inputAttention } from "../input/model.ts";
import type { Input } from "../input/state.ts";
import { preparedInputs } from "../chief/queue.ts";
import type { TopicResource } from "../topic/model.ts";
import { isRootTopic } from "../topic/boundary.ts";
import { BATCH_TYPE, type Batch, type BatchSpec, type BatchStatus } from "../batch/model.ts";
import { expandBatch } from "../batch/admission.ts";

/** Select one domain Input or one Deferred Batch. Gate retains conversational batching. Immediate always takes priority. */
export interface PreparedIntake { inputs: readonly Input[]; batch?: Batch }
/** @spec Among eligible items of equal attention, the resource creation timestamp decides.
 * @case tests/input-batch.test.ts
 */
export async function preparedIntake(resources: ResourceReader, topic: TopicResource, businessOnly = false, retryDelayMs = 60_000): Promise<PreparedIntake> {
  const inputs = await preparedInputs(resources, topic, isRootTopic(topic) ? 1 : 10, businessOnly, retryDelayMs);
  if (!isRootTopic(topic) || (inputs[0] && inputAttention(inputs[0].spec) === InputAttention.Immediate)) return { inputs };
  const active = await resources.page<BatchSpec, BatchStatus>(BATCH_TYPE, { matchIndex: { name: "active", value: topic.metadata.uid }, limit: 1 });
  if (active.items.length) return { inputs };
  let cursor: string | undefined;
  do {
    const page = await resources.page<BatchSpec, BatchStatus>(BATCH_TYPE, {
      matchIndex: { name: "ready", value: topic.metadata.uid }, direction: "asc", limit: 10, continue: cursor });
    for (const batch of page.items) {
      const input = inputs[0];
      if (input && compareInputPriority({ attention: inputAttention(input.spec), createdAt: input.metadata.creationTimestamp },
        { attention: batch.spec.attention, createdAt: batch.metadata.creationTimestamp }) <= 0) return { inputs };
      if (deliveryRetryDue(batch.status.assess, retryDelayMs)) return { inputs: await expandBatch(resources, batch), batch };
    }
    cursor = page.metadata.continue;
  } while (cursor);
  return { inputs };
}
