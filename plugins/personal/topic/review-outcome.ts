import type { ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import type { Input } from "../input/state.ts";
import { readNotes } from "../note/query.ts";
import { NOTE_TYPE } from "../note/model.ts";
import type { TopicPolicy } from "./config.ts";
import type { TopicResource, TopicStatus } from "./model.ts";
import { reviewEvidence } from "./review-evidence.ts";
import { reviewMaterialVersion } from "./review.ts";
import { understandingVersion, pendingAbsorption } from "./tree.ts";

/** @spec Maintenance scheduling facts commit atomically with Chief's Input result.
 * @why The receipt itself fences repeat completion; no Secretary acknowledgement or second Input phase is needed.
 * @spec A review acknowledges only its requested versions, never concurrent new material.
 * @case tests/topic-secretary.test.ts
 */
export async function reviewOutcome(resources: ResourceClient, input: Input, owner: TopicResource,
  topics: readonly TopicResource[], policy: TopicPolicy, at: string, executionId: string): Promise<ResourceCommit[]> {
  const evidence = reviewEvidence(input.spec);
  if (!evidence || input.spec.originRef?.uid !== owner.metadata.uid) return [{ operation: "patchStatus", resource: owner, patch: {} }];
  const versions = new Map(await Promise.all(topics.map(async t => [t.metadata.uid,
    understandingVersion(t, await readNotes(resources, t.metadata.uid, "subject"))] as const)));
  const absorbed = pendingAbsorption(topics, owner, true, versions).length === 0;
  const progressed = reviewMaterialVersion(topics, versions) !== evidence.materialVersion;
  const patch: Partial<TopicStatus> = {
    ...(absorbed ? { absorbAttempts: 0, nextAbsorbAt: new Date(Date.parse(at) + 60_000).toISOString() } : {}),
    reviewedMaterialVersion: evidence.materialVersion,
    notifiedWeaveRevision: Math.max(owner.status.notifiedWeaveRevision ?? 0, evidence.weaveRevision),
    idleReviewCount: progressed || (owner.status.lastInputAt ?? "") > String(input.spec.observation?.triggeredAt ?? input.metadata.creationTimestamp)
      ? 0 : policy.review.backoff ? Math.min(Number.MAX_SAFE_INTEGER, (owner.status.idleReviewCount ?? 0) + 1) : 0,
  };
  const writes: ResourceCommit[] = [];
  for (const entry of evidence.pressure) {
    const topic = entry.uid === owner.metadata.uid ? owner : topics.find(t => t.metadata.uid === entry.uid);
    if (!topic || topic.metadata.deletionTimestamp || !topic.status.notePressure) continue;
    const reduced = (await resources.page(NOTE_TYPE, { limit: 1,
      matchIndex: { name: "reducedSubject", value: JSON.stringify([entry.uid, executionId]) } })).items.length > 0;
    const notePressure = { ...topic.status.notePressure, ...(reduced
      ? { attempts: 0, nextAt: new Date(Date.parse(at) + policy.capacityCooldownSeconds * 1000).toISOString() }
      : { reviewedVersion: entry.version }) };
    if (topic.metadata.uid === owner.metadata.uid) patch.notePressure = notePressure;
    else writes.push({ operation: "patchStatus", resource: topic, patch: { notePressure } });
  }
  return [...writes, { operation: "patchStatus", resource: owner, patch }];
}
