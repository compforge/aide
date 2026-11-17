import { isGateTopic } from "../topic/boundary.ts";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { retryOnConflict, type PluginContext, type ResourceClient } from "@compforge/aide-plugin";
import { digest } from "../identity.ts";
import { resourceRef } from "../input/state.ts";
import { TOPIC_TYPE, type TopicResource } from "../topic/model.ts";
import { readTopicRoot } from "../topic/tree.ts";
import { topicPolicy } from "../topic/config.ts";
import { NOTE_TYPE, noteMaxChars, noteVersion, noteTextVersion, type NoteResource } from "./model.ts";

const candidate = z.object({ noteId: z.string(), version: z.string(), chars: z.number().int().nonnegative(), maxChars: z.number().int().positive() }).strict();
export const NotePressureSchema = z.object({ rootUid: z.string(), version: z.string(), maxNotes: z.number().int().positive(),
  count: z.number().int().nonnegative(), truncated: z.boolean(), notes: z.array(candidate).max(20), oversized: z.array(candidate).max(20),
  nextAt: z.string().datetime(), attempts: z.number().int().nonnegative().max(5),
}).strict();
export type NotePressure = z.infer<typeof NotePressureSchema>;
export type NotePressureTopic = { uid: string; name?: string; pressure: NotePressure };
const reference = (n: NoteResource) => ({ noteId: n.metadata.name, version: noteVersion(n), chars: n.spec.text.length, maxChars: noteMaxChars(n.spec) });

/** @spec Inspect direct active ordinary Notes to maxNotes+1; oversized queries include summary Notes and stop at 20.
 * @why Content review is not consolidation. Indexed pressure discovery includes already reviewed Notes without scanning history.
 * @link docs/personal/note.md
 */
export async function refreshNotePressure(context: Pick<PluginContext, "resources" | "logger" | "instance">, topic: TopicResource) {
  if (isGateTopic(topic)) return;
  const maxNotes = topic.spec.maxNotes ?? topicPolicy(context.instance.config.topic).maxNotes;
  await retryOnConflict(async () => {
    const current = await context.resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(topic));
    if (!current || current.metadata.deletionTimestamp) return;
    const [notes, oversized] = await Promise.all([
      context.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, { namespace: "v1", limit: maxNotes + 1, direction: "desc", matchIndex: { name: "pressureSubject", value: current.metadata.uid } }),
      context.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, { namespace: "v1", limit: 20, direction: "desc", matchIndex: { name: "oversizedSubject", value: current.metadata.uid } }),
    ]);
    const root = notes.items.length > maxNotes || oversized.items.length ? await readTopicRoot(context.resources, resourceRef(current)) : undefined;
    const previous = current.status.notePressure;
    if (!root) {
      if (previous) await context.resources.patch(current, { type: "json", value: [{ op: "remove", path: "/status/notePressure" }] }, { resourceVersion: current.metadata.resourceVersion });
      return;
    }
    const facts = { maxNotes, count: notes.items.length, truncated: !!notes.metadata.continue || !!oversized.metadata.continue,
      notes: notes.items.slice(0, 20).map(reference), oversized: oversized.items.map(reference) };
    // The fingerprint covers the whole bounded sample, even when only 20 IDs are presented.
    const identity = (n: NoteResource) => [n.metadata.uid, noteTextVersion(n), noteMaxChars(n.spec)];
    const version = digest([root.metadata.uid, maxNotes, notes.items.map(identity), oversized.items.map(identity)]);
    const pressure: NotePressure = { ...facts, rootUid: root.metadata.uid, version,
      nextAt: previous?.version === version ? previous.nextAt : new Date(0).toISOString(), attempts: previous?.version === version ? previous.attempts : 0 };
    if (isDeepStrictEqual(previous, pressure)) return;
    await context.resources.patchStatus(current, { notePressure: pressure }, { resourceVersion: current.metadata.resourceVersion });
    context.logger.info("Topic Note pressure observed", { attributes: { topicUid: current.metadata.uid, rootUid: root.metadata.uid,
      maxNotes, count: facts.count, oversized: facts.oversized.length, version } });
  });
}

/** @spec Each root takes at most eight due Topics; unchanged pressure retries with bounded backoff.
 * @why Per-Topic durable receipts aggregate independent requests without losing work behind an existing review Input.
 */
export async function dueNotePressure(resources: ResourceClient, root: TopicResource, now = Date.now(), limit = 8): Promise<NotePressureTopic[]> {
  const page = await resources.page<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE, {
    namespace: "v1", limit, matchIndex: { name: "notePressure", value: root.metadata.uid }, direction: "asc",
  });
  const result: NotePressureTopic[] = [];
  for (const topic of page.items) {
    const pressure = topic.status.notePressure!;
    if (Date.parse(pressure.nextAt) > now) continue;
    if ((await readTopicRoot(resources, resourceRef(topic)))?.metadata.uid !== root.metadata.uid) continue;
    result.push({ uid: topic.metadata.uid, name: topic.spec.name, pressure });
  }
  return result;
}
