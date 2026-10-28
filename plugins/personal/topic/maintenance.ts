import { workPhase } from "../status.ts";
import type { ResourceReader } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { WORK_TYPES, type WorkResource } from "../resources.ts";
import type { TopicResource } from "./model.ts";
import { topicPolicy } from "./config.ts";

/** Reconciler selects a bounded maintenance agenda; Chief decides whether and how to reorganize. */
export async function maintenanceAgenda(resources: ResourceReader, topics: readonly TopicResource[], config?: unknown) {
  const policy = topicPolicy(config);
  const counts = await Promise.all(topics.map(async topic => {
    const inputs = await resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "topic", value: topic.metadata.uid } });
    const work = (await Promise.all(WORK_TYPES.map(type => resources.list<WorkResource["spec"], WorkResource["status"]>(type,
      { matchIndex: { name: "topic", value: topic.metadata.uid } })))).flat();
    return { uid: topic.metadata.uid, ...(topic.spec.name ? { name: topic.spec.name } : {}),
      inputs: inputs.filter(i => !i.metadata.deletionTimestamp && i.spec.origin !== "trigger").length,
      work: work.filter(w => !w.metadata.deletionTimestamp && (w.kind === "Routine" || workPhase(w) !== "done")).length,
      children: topics.filter(t => t.spec.parentRef?.uid === topic.metadata.uid).length };
  }));
  const material = counts.filter(c => c.inputs > policy.maxInput || c.work > policy.maxWork);
  const children = counts.filter(c => c.children > policy.maxChildren);
  const reason = material.length ? "organize_material" : children.length ? "organize_children" : "review";
  const candidates = material.length ? material : children;
  return { reason, thresholds: { maxInput: policy.maxInput, maxWork: policy.maxWork, maxChildren: policy.maxChildren },
    affectedTopics: candidates.length, topics: candidates.slice(0, 8) };
}
