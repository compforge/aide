import type { ResourceReader } from "@compforge/aide-plugin";
import { InputAttention, inputAttention } from "../input/model.ts";
import type { Input } from "../input/state.ts";
import { preparedInputs } from "../chief/queue.ts";
import type { TopicResource } from "../topic/model.ts";
import { isRootTopic } from "../topic/boundary.ts";
import { BATCH_TYPE, type Batch, type BatchSpec, type BatchStatus } from "../batch/model.ts";
import { expandBatch } from "../batch/admission.ts";

/** Select one domain Input or one Deferred Batch. Gate retains conversational batching. Immediate always takes priority. */
export interface PreparedIntake { inputs: readonly Input[]; batch?: Batch }
export async function preparedIntake(resources: ResourceReader, topic: TopicResource, businessOnly = false, retryDelayMs = 60_000): Promise<PreparedIntake> {
  const inputs = await preparedInputs(resources, topic, isRootTopic(topic) ? 1 : 10, businessOnly, retryDelayMs);
  if (!isRootTopic(topic) || (inputs[0] && inputAttention(inputs[0].spec) === InputAttention.Immediate)) return { inputs };
  const active = await resources.page<BatchSpec, BatchStatus>(BATCH_TYPE, { matchIndex: { name: "active", value: topic.metadata.uid }, limit: 1 });
  if (active.items.length) return { inputs };
  const head = async (name: "ready" | "retry") => (await resources.page<BatchSpec, BatchStatus>(BATCH_TYPE,
    { matchIndex: { name, value: topic.metadata.uid }, limit: 1 })).items[0];
  const [first, retry] = await Promise.all([head("ready"), head("retry")]);
  const dueAt = retry && Date.parse(retry.status.assess!.errorAt!) + retryDelayMs;
  const batch = retry && dueAt !== undefined && dueAt <= Date.now() && (!first || dueAt < Date.parse(first.spec.oldestAt)) ? retry : first;
  return batch ? { inputs: await expandBatch(resources, batch), batch } : { inputs };
}
