import { inWorkWindow } from "../topic/activity.ts";
import { isResourceVersionConflict, type PluginContext, type ResourceReader } from "@compforge/aide-plugin";
import { ADDRESS_TYPE } from "../address/model.ts";
import { PERSON_TYPE } from "../person/model.ts";
import { NOTE_TYPE } from "../note/model.ts";
import type { SummaryResource } from "../note/summary.ts";
import { SummaryOwnerSchema } from "../input/review.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { inputRef, resourceRef } from "../input/state.ts";
import { reviewAttention } from "./candidate.ts";
import { digest } from "../identity.ts";
import { commitStatus } from "../status.ts";
import { ensureDefaultTopic } from "../topic/default.ts";
import { TOPIC_TYPE, type TopicResource } from "../topic/model.ts";
import { readTopicRoot } from "../topic/tree.ts";

const interval = 15 * 60_000;
const reviewQuestions = {
  Topic: "When someone returns to work on this Topic, what scope, constraints, decisions and reusable conclusions will help them understand it? Read the Topic in its current place in the tree. Keep child-specific details with the child and retain milestones only when they explain the current state.",
  Person: "When collaborating with this person on a different matter, what should you already know about their current responsibilities, expressed views, preferences or working style? Read their profile and Notes associated through people across Topics. Distinguish their own statements from others' accounts and one-off assignments from continuing roles.",
  Address: "When entering this communication place again, what do you need to know to decide whether it suits the discussion and how to communicate here? Read the Address and Notes associated through addresses. Keep its recurring purpose, audience and communication conventions. A conversation held here is evidence about the place only when it establishes a lasting use or convention. Known participants are partial evidence of audience and grant no disclosure authority.",
} as const;

async function oldestWithNotes(reader: ResourceReader, type: typeof TOPIC_TYPE | typeof PERSON_TYPE | typeof ADDRESS_TYPE, now: number) {
  const association = type.kind === "Person" ? "recentPeople" : type.kind === "Address" ? "recentAddresses" : "recentSubject";
  if (type.kind !== "Topic") {
    const shared = await reader.page<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE, { matchIndex: { name: "default", value: "default" }, limit: 1 });
    if (!inWorkWindow(shared.items[0], now)) return;
  }
  let cursor: string | undefined;
  do {
    const page = await reader.page<unknown, SummaryResource["status"]>(type, { namespace: "v1", limit: 32, continue: cursor,
      matchIndex: { name: "summaryReview", value: "owner" }, direction: "asc" });
    for (const owner of page.items) {
      if (owner.kind === "Topic" && !inWorkWindow(await readTopicRoot(reader, resourceRef(owner)), now)) continue;
      if (owner.status.summaryRevision) return owner;
      for (const name of new Set(["recentSubject", association])) {
        const notes = await reader.page(NOTE_TYPE, { matchIndex: { name, value: owner.metadata.uid }, limit: 1 });
        if (notes.items.length) return owner;
      }
    }
    cursor = page.metadata.continue;
  } while (cursor);
}

/** Gate owns the quarter-hour clock. Only an empty check or a committed dispatch consumes a slot.
 * @link docs/personal/secretary.md#摘要复核
 * @case tests/summary-review.test.ts
 */
export async function summaryCandidate(context: Pick<PluginContext, "resources" | "logger">, gate: TopicResource, now = Date.now(), dispatchRoot?: TopicResource) {
  const slot = Math.floor(now / interval) * interval;
  const next = slot + interval - now;
  const last = Date.parse(gate.status.summaryCheckAt ?? gate.metadata.creationTimestamp);
  if (last >= slot) return { requeueAfterMs: next };
  const at = new Date(slot).toISOString();
  const clock = { operation: "patchStatus" as const, resource: gate, patch: { summaryCheckAt: at } };
  const candidates = await Promise.all([TOPIC_TYPE, PERSON_TYPE, ADDRESS_TYPE].map(type => oldestWithNotes(context.resources, type, now)));
  const [owner] = candidates.filter(item => !!item).sort((a, b) =>
    (a.status.summaryReviewedAt ?? "").localeCompare(b.status.summaryReviewedAt ?? "") || a.metadata.uid.localeCompare(b.metadata.uid));
  if (!owner) {
    if (!dispatchRoot) await commitStatus(context.resources, [clock]);
    return { requeueAfterMs: next };
  }
  const chief = owner.kind === "Topic" ? await readTopicRoot(context.resources, resourceRef(owner)) : await ensureDefaultTopic(context.resources);
  if (!chief || dispatchRoot?.metadata.uid !== chief.metadata.uid || chief.status.execution) return { requeueAfterMs: next };
  const pending = await context.resources.page(INPUT_TYPE, { matchIndex: { name: "internalPending", value: JSON.stringify([chief.metadata.uid, "aide:summary"]) }, limit: 1 });
  if (pending.items.length) return { requeueAfterMs: next };
  const createdAt = new Date(Math.max(last, Date.parse(owner.status.summaryReviewedAt ?? owner.metadata.creationTimestamp))).toISOString();
  const attention = reviewAttention(createdAt, interval, now);
  const topic = resourceRef(chief), target = SummaryOwnerSchema.parse(resourceRef(owner));
  const name = `summary-${digest([gate.metadata.uid, at])}`;
  const dispatch = async () => {
    try {
      await commitStatus(context.resources, [clock, { operation: "create", type: INPUT_TYPE, name,
        spec: { origin: "aide:summary", originId: "personal.topic", originRef: topic, topicId: chief.spec.id, attention,
          text: `Review the Summary for ${JSON.stringify(target)}. ${reviewQuestions[target.kind]} Use read_note and list_notes to compare the whole Summary with related evidence. Record completion even if the Summary stays unchanged.`,
          observation: { summaryOwner: target, checkedAt: at, candidateSince: createdAt } },
        status: { topic, route: { completedAt: at, result: { topics: [topic], reason: "Idle Summary review" } }, assess: { topic } } }]);
    } catch (error) {
      if (!isResourceVersionConflict(error) && !String(error).includes("Chief has queued work") && !String(error).includes("Resource capacity exhausted")) throw error;
      context.logger.debug?.("Secretary skipped Summary check", { attributes: { at, chiefUid: topic.uid, reason: String(error) } });
      return;
    }
    context.logger.info("Secretary scheduled Summary review", { attributes: { at, inputId: name, attention, candidateSince: createdAt, chiefUid: topic.uid, ownerKind: target.kind, ownerUid: target.uid } });
    return context.resources.get<InputSpec, InputStatus>(inputRef(name));
  };
  return { requeueAfterMs: next, candidate: { attention, createdAt, dispatch } };
}
