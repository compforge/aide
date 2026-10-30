import { createHash } from "node:crypto";
import type { PluginContext } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { assignInput, invalidateAssignment } from "../input/assignment.ts";
import { resourceRef } from "../input/state.ts";
import { patchStatus } from "../status.ts";
import type { TopicResource } from "./model.ts";

const batchSize = 40;
/** Include ancestor generations so A→B→A between checks still invalidates the cache. */
async function ancestryVersion(context: PluginContext, topic: TopicResource) {
  const path: Array<[string, number]> = [], seen = new Set<string>();
  let current = topic;
  while (true) {
    if (current.metadata.deletionTimestamp || seen.has(current.metadata.uid)) throw new Error("Topic assignment path unavailable");
    seen.add(current.metadata.uid); path.push([current.metadata.uid, current.metadata.generation]);
    if (!current.spec.parentRef) break;
    const parent = await context.resources.get<TopicResource["spec"], TopicResource["status"]>(current.spec.parentRef);
    if (!parent) throw new Error("Topic assignment parent unavailable");
    current = parent;
  }
  return createHash("sha256").update(JSON.stringify(path)).digest("hex");
}

/** @spec Each Topic converges its direct unclaimed Input assignments in bounded, restartable batches.
 * @why Persisted ancestry and progress replace lossy Watch fan-out. Periodic Topic reconciliation repairs missed notifications.
 * @case tests/input-assignment.test.ts
 * @link docs/personal/input.md#挂载分派与执行
 */
export async function reconcileAssignments(context: PluginContext, topic: TopicResource): Promise<boolean> {
  const version = await ancestryVersion(context, topic);
  let progress = topic.status.assignmentRefresh;
  if (progress?.version !== version) {
    progress = { version, cursor: "", complete: false };
    topic = await patchStatus(context.resources, topic, { assignmentRefresh: progress });
    context.logger.info("Topic assignment refresh started", { attributes: { topicUid: topic.metadata.uid, version } });
  }
  if (!progress.complete) {
    const page = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
      namespace: topic.metadata.namespace, matchIndex: { name: "assignmentPending", value: topic.metadata.uid },
      consistency: "live", limit: batchSize, continue: progress.cursor });
    for (const input of page.items) await invalidateAssignment(context, input);
    progress = { version, cursor: page.metadata.continue, complete: !page.metadata.continue };
    // CAS fences a concurrent parent/spec change or another refresh; failed pages are safe to repeat.
    topic = await patchStatus(context.resources, topic, { assignmentRefresh: progress });
    if (progress.complete) context.logger.info("Topic assignment refresh completed", { attributes: { topicUid: topic.metadata.uid, version } });
  }
  const missing = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
    namespace: topic.metadata.namespace, matchIndex: { name: "unassigned", value: topic.metadata.uid }, limit: batchSize });
  for (const input of missing.items) await assignInput(context, input);
  return !progress.complete || !!missing.metadata.continue;
}
