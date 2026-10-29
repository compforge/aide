import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Resource, ResourceValidationContext } from "@compforge/aide-plugin";
import { requireTopic } from "./topic/ownership.ts";
import type { NoteStatus } from "./note/model.ts";
import type { ResourceContext } from "./context.ts";
export const contentVersion = (resource: Resource<unknown, { summary: string }>) =>
  createHash("sha256").update(JSON.stringify([resource.metadata.uid, resource.status.summary])).digest("hex");
/** @spec Authorization reads current execution and ancestry in the write transaction, independent of scheduling versions.
 * @case tests/notes.test.ts
 * @link docs/personal/note.md
 */
export function requireContentWriter(target: Resource<unknown, unknown>, writer: NoteStatus["writer"], context: ResourceValidationContext) {
  const actor = context.get<unknown, { execution?: { id: string } | null }>(writer.resource, writer.resource.uid);
  if (target.metadata.deletionTimestamp || !actor || actor.metadata.name !== writer.resource.name || actor.metadata.namespace !== writer.resource.namespace || actor.metadata.deletionTimestamp || actor.status.execution?.id !== writer.executionId)
    throw new Error("Content writer execution is no longer active");
  if (actor.kind !== "Topic") {
    if (actor.metadata.uid !== target.metadata.uid) throw new Error("Work may only edit its own content");
    return;
  }
  requireTopic(writer.resource, context);
  if (target.kind === "Person") return;
  let topic = target.kind === "Topic" ? requireTopic({ ...target, ...target.metadata }, context)
    : requireTopic((target.status as { topic?: import("@compforge/aide-plugin").ResourceRef }).topic, context);
  const seen = new Set<string>();
  while (topic.metadata.uid !== actor.metadata.uid) {
    if (seen.has(topic.metadata.uid) || !topic.spec.parentRef) throw new Error("Content target is outside this Chief's Topic subtree");
    seen.add(topic.metadata.uid); topic = requireTopic(topic.spec.parentRef, context);
  }
}
export function guardContext(previous: Resource<unknown, ResourceContext>, current: Resource<unknown, ResourceContext>, context: ResourceValidationContext) {
  if (current.status.contextWriter && (previous.status.summary !== current.status.summary || !isDeepStrictEqual(previous.status.contextWriter, current.status.contextWriter)))
    requireContentWriter(current, current.status.contextWriter, context);
}
