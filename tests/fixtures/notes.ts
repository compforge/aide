import type { Resource, ResourceClient, ResourceRef } from "@compforge/aide-plugin";
import { resourceRef } from "../../plugins/personal/input/state.ts";
import { readTopicRoot } from "../../plugins/personal/topic/tree.ts";
import { TOPIC_TYPE } from "../../plugins/personal/topic/model.ts";
import { NOTE_TYPE, SubjectSchema } from "../../plugins/personal/note/model.ts";
import type { PersonRef } from "../../plugins/personal/person/model.ts";
export async function seedNotes(resources: ResourceClient, subject: Resource<unknown, unknown>, entries: readonly { id: string; text: string; createdAt?: string; updatedAt?: string; people?: PersonRef[] }[]) {
  let target = subject;
  if (subject.kind === "Person") target = await resources.get({ ...TOPIC_TYPE, namespace: "v1", name: "note-fixture" })
    ?? await resources.create(TOPIC_TYPE, { name: "note-fixture", spec: { id: "note-fixture" }, status: {} });
  const actor = target.kind === "Topic" ? (await readTopicRoot(resources, resourceRef(target)))! : target as Resource<unknown, { execution?: { id: string; startedAt: string } | null }>;
  const existing = actor.status.execution;
  const live = existing ? actor : await resources.patchStatus(actor, { execution: { id: "fixture", startedAt: new Date().toISOString() } });
  for (const entry of entries) await resources.create(NOTE_TYPE, { name: `${subject.metadata.uid}-${entry.id}`,
    spec: { subject: SubjectSchema.parse(resourceRef(target)), text: entry.text, people: entry.people ?? (subject.kind === "Person" ? [resourceRef(subject) as PersonRef] : []) },
    status: { updatedAt: entry.updatedAt ?? new Date().toISOString(), writer: { resource: SubjectSchema.parse(resourceRef(live)), executionId: live.status.execution!.id } } });
  if (!existing) await resources.patch(live, { type: "json", value: [{ op: "remove", path: "/status/execution" }] });
}
