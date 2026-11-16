import type { ResourceReader } from "@compforge/aide-plugin";
import { InputAttention, inputAttention, assessmentRetryDue } from "../input/model.ts";
import type { Input } from "../input/state.ts";
import { preparedInputs } from "../input/scheduling.ts";
import type { TopicResource } from "./model.ts";
import { isProcessingRoot } from "./boundary.ts";
import { BATCH_TYPE, type Batch, type BatchSpec, type BatchStatus } from "../batch/model.ts";
import { expandBatch } from "../batch/admission.ts";

/** Chief selects one prepared Deferred Batch or independent Inputs. Immediate always takes priority. */
export interface PreparedIntake { inputs: readonly Input[]; batch?: Batch }
export async function preparedIntake(resources: ResourceReader, topic: TopicResource, businessOnly = false, retryDelayMs = 60_000): Promise<PreparedIntake> {
  if (!isProcessingRoot(topic)) return { inputs: [] };
  const inputs = await preparedInputs(resources, topic, 10, businessOnly, retryDelayMs);
  if (inputs[0] && inputAttention(inputs[0].spec) === InputAttention.Immediate) return { inputs };
  const active = await resources.page<BatchSpec, BatchStatus>(BATCH_TYPE, { matchIndex: { name: "active", value: topic.metadata.uid }, limit: 1 });
  if (active.items.length) return { inputs };
  const batch = (await resources.page<BatchSpec, BatchStatus>(BATCH_TYPE,
    { matchIndex: { name: "ready", value: topic.metadata.uid }, limit: 1 })).items[0];
  return batch && assessmentRetryDue(batch.status.assess, retryDelayMs) ? { inputs: await expandBatch(resources, batch), batch } : { inputs };
}
