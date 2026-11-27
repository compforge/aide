import type { ResourceReader } from "@compforge/aide-plugin";
import { InputAttention, inputAttention } from "../input/model.ts";
import type { Input } from "../input/state.ts";
import { preparedInputs } from "./queue.ts";
import type { TopicResource } from "../topic/model.ts";
import { isRootTopic } from "../topic/boundary.ts";
import { BATCH_TYPE, type Batch, type BatchSpec, type BatchStatus } from "../batch/model.ts";
import { expandBatch } from "../batch/admission.ts";
import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { topicPolicy } from "../topic/config.ts";
import { immediate } from "../execution/input.ts";

/** Chief selects one prepared Deferred Batch or independent Inputs. Immediate always takes priority. */
export interface PreparedIntake { inputs: readonly Input[]; batch?: Batch }
export async function preparedIntake(resources: ResourceReader, topic: TopicResource, businessOnly = false, retryDelayMs = 60_000): Promise<PreparedIntake> {
  const inputs = await preparedInputs(resources, topic, 10, businessOnly, retryDelayMs);
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


export async function submitChiefPending(context: PluginContext, execution: ReconcileContext, owner: Readonly<TopicResource>) {
  if (!owner.status.execution) return;
  const ready = await preparedIntake(context.resources, owner, true, topicPolicy(context.instance.config.topic).trigger.intervalSeconds * 1000);
  if (ready.inputs.length) {
    const urgent = ready.batch ? [] : ready.inputs.filter(i => immediate(i.spec));
    const inputs = urgent.length ? urgent : ready.inputs;
    const result = await execution.verbs.action<{ accepted: boolean; reason?: string }>("submit_topic", {
      ...(ready.batch ? { batchId: ready.batch.metadata.uid } : {}), inputId: inputs[0]!.metadata.name, inputIds: inputs.map(i => i.metadata.name), operation: urgent.length ? "steer" : "followUp",
    });
    if (result.state === "failure") throw new Error(`Agent Input admission failed: ${result.error ?? "unknown error"}`);
    context.logger.info("Chief business batch notification", { attributes: { topicUid: owner.metadata.uid,
      count: inputs.length, batchId: ready.batch?.metadata.uid ?? null,
      operation: urgent.length ? "steer" : "followUp", accepted: result.state === "success" && result.value.accepted } });
    return result.state === "success" && (result.value.accepted || ["not_running", "admission_conflict"].includes(result.value.reason ?? ""))
      ? { requeueAfterMs: 100 } : undefined;
  }
}
