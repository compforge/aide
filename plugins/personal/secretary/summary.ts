import type { PluginContext, ResourceReader } from "@compforge/aide-plugin";
import { ADDRESS_TYPE } from "../address/model.ts";
import { PERSON_TYPE } from "../person/model.ts";
import { NOTE_TYPE } from "../note/model.ts";
import type { SummaryResource } from "../note/summary.ts";
import { SummaryOwnerSchema } from "../input/review.ts";
import { INPUT_TYPE, InputAttention, type InputSpec, type InputStatus } from "../input/model.ts";
import { inputRef, resourceRef } from "../input/state.ts";
import { BATCH_TYPE } from "../batch/model.ts";
import { digest } from "../identity.ts";
import { commitStatus } from "../status.ts";
import { ensureDefaultTopic } from "../topic/default.ts";
import { TOPIC_TYPE, type TopicResource } from "../topic/model.ts";
import { readTopicRoot, readTopicSubtree } from "../topic/tree.ts";

const interval = 15 * 60_000;
const reviewQuestions = {
  Topic: "When someone returns to work on this Topic, what scope, constraints, decisions and reusable conclusions will help them understand it? Read the Topic in its current place in the tree. Keep child-specific details with the child and retain milestones only when they explain the current state.",
  Person: "When collaborating with this person on a different matter, what should you already know about their current responsibilities, expressed views, preferences or working style? Read their profile and Notes associated through people across Topics. Distinguish their own statements from others' accounts and one-off assignments from continuing roles.",
  Address: "When entering this communication place again, what do you need to know to decide whether it suits the discussion and how to communicate here? Read the Address and Notes associated through addresses. Keep its recurring purpose, audience and communication conventions. A conversation held here is evidence about the place only when it establishes a lasting use or convention. Known participants are partial evidence of audience and grant no disclosure authority.",
} as const;

async function oldestWithNotes(reader: ResourceReader, type: typeof TOPIC_TYPE | typeof PERSON_TYPE | typeof ADDRESS_TYPE) {
  const association = type.kind === "Person" ? "recentPeople" : type.kind === "Address" ? "recentAddresses" : "recentSubject";
  if (type.kind !== "Topic") {
    const shared = await reader.page<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE, { matchIndex: { name: "default", value: "default" }, limit: 1 });
    if (shared.items[0]?.status.phase === "dormant") return;
  }
  let cursor: string | undefined;
  do {
    const page = await reader.page<unknown, SummaryResource["status"]>(type, { namespace: "v1", limit: 32, continue: cursor,
      matchIndex: { name: "summaryReview", value: "owner" }, direction: "asc" });
    for (const owner of page.items) {
      if (owner.kind === "Topic" && (await readTopicRoot(reader, resourceRef(owner)))?.status.phase === "dormant") continue;
      if (owner.status.summaryRevision) return owner;
      for (const name of new Set(["recentSubject", association])) {
        const notes = await reader.page(NOTE_TYPE, { matchIndex: { name, value: owner.metadata.uid }, limit: 1 });
        if (notes.items.length) return owner;
      }
    }
    cursor = page.metadata.continue;
  } while (cursor);
}

/** @spec One global quarter-hour check. A busy or queued Chief consumes this slot. Repeated wakes and restarts never replay earlier slots.
 * @why Gate owns the singleton clock; the selected domain Chief owns the Input and its execution.
 * @link docs/personal/secretary.md#摘要复核
 * @case tests/summary-review.test.ts
 */
export async function checkSummary(context: Pick<PluginContext, "resources" | "logger">, gate: TopicResource, now = Date.now(), dispatchRoot?: TopicResource) {
  const slot = Math.floor(now / interval) * interval;
  const next = slot + interval - now;
  if (Date.parse(gate.status.summaryCheckAt ?? gate.metadata.creationTimestamp) >= slot) return { requeueAfterMs: next };
  const at = new Date(slot).toISOString();
  const clock = { operation: "patchStatus" as const, resource: gate, patch: { summaryCheckAt: at } };
  const candidates = await Promise.all([TOPIC_TYPE, PERSON_TYPE, ADDRESS_TYPE].map(type => oldestWithNotes(context.resources, type)));
  const [owner] = candidates.filter(item => !!item).sort((a, b) =>
    (a.status.summaryReviewedAt ?? "").localeCompare(b.status.summaryReviewedAt ?? "") || a.metadata.uid.localeCompare(b.metadata.uid));
  const chief = owner && (owner.kind === "Topic" ? await readTopicRoot(context.resources, resourceRef(owner)) : await ensureDefaultTopic(context.resources));
  if (!chief || !owner || chief.status.execution) {
    if (dispatchRoot) return { requeueAfterMs: next };
    await commitStatus(context.resources, [clock]);
    context.logger.debug?.("Secretary skipped Summary check", { attributes: { at, reason: chief ? "chief_busy" : "no_candidate", chiefUid: chief?.metadata.uid ?? null } });
    return { requeueAfterMs: next };
  }
  if (dispatchRoot?.metadata.uid !== chief.metadata.uid) {
    if (!dispatchRoot) {
      // The global clock consumes busy slots even while the domain controller is awaiting inference.
      const pending = (await context.resources.page(INPUT_TYPE, { matchIndex: { name: "assignedPending", value: chief.metadata.uid }, limit: 1 })).items.length
        || (await context.resources.page(BATCH_TYPE, { matchIndex: { name: "open", value: chief.metadata.uid }, limit: 1 })).items.length;
      let occupied = !!pending;
      if (!occupied) for (const member of await readTopicSubtree(context.resources, resourceRef(chief))) {
        if ((await context.resources.page(INPUT_TYPE, { matchIndex: { name: "unassigned", value: member.metadata.uid }, limit: 1 })).items.length) {
          occupied = true;
          break;
        }
      }
      if (occupied) await commitStatus(context.resources, [clock]);
    }
    return { requeueAfterMs: next };
  }
  const topic = resourceRef(chief), target = SummaryOwnerSchema.parse(resourceRef(owner));
  const name = `summary-${digest([gate.metadata.uid, at])}`;
  try {
    await commitStatus(context.resources, [clock, { operation: "create", type: INPUT_TYPE, name,
      spec: { origin: "aide:summary", originId: "personal.topic", originRef: topic, topicId: chief.spec.id, attention: InputAttention.Normal,
        text: `Review the Summary for ${JSON.stringify(target)}. ${reviewQuestions[target.kind]} Use read_note and list_notes to compare the whole Summary with related evidence. Record completion even if the Summary stays unchanged.`,
        observation: { summaryOwner: target, checkedAt: at } },
      status: { topic, route: { completedAt: at, result: { topics: [topic], reason: "Idle Summary review" } }, assess: { topic } } }]);
  } catch (error) {
    if (!String(error).includes("Chief is dormant") && !String(error).includes("Chief has queued work") && !String(error).includes("Resource capacity exhausted")) throw error;
    await commitStatus(context.resources, [clock]);
    context.logger.debug?.("Secretary skipped Summary check", { attributes: { at, chiefUid: topic.uid, reason: String(error) } });
    return { requeueAfterMs: next };
  }
  context.logger.info("Secretary scheduled Summary review", { attributes: { at, inputId: name, chiefUid: topic.uid, ownerKind: target.kind, ownerUid: target.uid } });
  const input = await context.resources.get<InputSpec, InputStatus>(inputRef(name));
  return { requeueAfterMs: next, input };
}
