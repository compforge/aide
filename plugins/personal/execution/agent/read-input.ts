import type { ResourceRef } from "@compforge/aide-plugin";
import { chiefInputs } from "../../chief/inputs.ts";
import { batchForInput } from "../../batch/view.ts";
import { summaryText, summaryReference } from "../../note/summary.ts";
import { contentVersion } from "../../context-write.ts";
import { notes } from "../../note/query.ts";
import { attemptOf, type Input } from "../../input/state.ts";
import type { TopicResource } from "../../topic/model.ts";
import { describeInput } from "../../input/printer.ts";
import { deliveryFinished, InputAttention, inputAttention } from "../../input/model.ts";
import type { Store } from "../../work/store.ts";

function evidencePage(materials: readonly Input[], offset: number, sourceIds = false) {
  const description = materials.map(input => describeInput(input, sourceIds)).join("\n\n");
  return { text: description.slice(offset, offset + 8000), nextOffset: offset + 8000 < description.length ? offset + 8000 : null };
}

export function readRouteInput(store: Store, owner: ResourceRef, id: string | undefined, offset: number) {
  const inputs = store.topics.inputStore.query("routePending", "pending");
  if (!id) return { inputs: inputs.slice(offset, offset + 20).map(i => ({ inputId: i.metadata.name, batchId: i.status.batchId,
    attention: inputAttention(i.spec), status: attemptOf(i, owner) })), nextOffset: offset + 20 < inputs.length ? offset + 20 : null };
  const input = inputs.find(i => i.metadata.name === id);
  if (!input) throw new Error("Input is not attached to this resource");
  return { inputId: id, batch: batchForInput(store.resources, input), attention: inputAttention(input.spec),
    status: attemptOf(input, owner), ...evidencePage([input], offset) };
}

export function readChiefInput(store: Store, topic: TopicResource, id: string | undefined, offset: number, maxChars: number) {
  if (!id) {
    const groups = chiefInputs(store.topics.pending(topic.metadata.uid));
    const items = Array.from(groups, ([inputId, materials]) => {
      const first = materials[0]!, batch = batchForInput(store.resources, first);
      return { inputId, attention: batch?.spec.attention ?? inputAttention(first.spec), status: batch?.status.assess ?? first.status.assess };
    }).filter(item => !deliveryFinished(item.status));
    const summaryNote = summaryReference(store.resources, topic);
    return { context: { version: contentVersion(topic), summary: summaryText(store.resources, topic), summaryUid: summaryNote?.uid,
      summaryNote, recent: notes(store.resources, topic.metadata.uid, "subject"), maxChars }, inputs: items.slice(offset, offset + 20),
      nextOffset: offset + 20 < items.length ? offset + 20 : null };
  }
  const scope = new Set(store.topics.scope(topic.metadata.uid).map(t => t.metadata.uid));
  const attached = (i: Input) => !i.metadata.deletionTimestamp && !!i.status.topic && scope.has(i.status.topic.uid);
  const members = store.topics.inputStore.query("batch", id).filter(attached);
  if (members.length) {
    const first = members[0]!, batch = batchForInput(store.resources, first);
    return { inputId: id, attention: InputAttention.Normal, status: batch?.status.assess ?? first.status.assess, ...evidencePage(members, offset, true) };
  }
  const input = store.topics.inputStore.get(id);
  if (!input || !attached(input)) throw new Error("Input is not attached to this resource");
  return { inputId: id, attention: inputAttention(input.spec), status: input.status.assess, ...evidencePage([input], offset, !!input.status.batchId) };
}
