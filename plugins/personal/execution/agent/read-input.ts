import { batchForInput } from "../../batch/view.ts";
import { summaryText, summaryReference } from "../../note/summary.ts";
import { contentVersion } from "../../context-write.ts";
import { notes } from "../../note/query.ts";
import { belongsToTopic, attemptOf } from "../../input/state.ts";
import type { TopicSpec, TopicStatus } from "../../topic/model.ts";
import { inputPrinter } from "../../input/printer.ts";
import type { Resource } from "@compforge/aide-plugin";
import { inputAttention, type InputSpec, type InputStatus } from "../../input/model.ts";
import type { Store } from "../../work/store.ts";
import { TOPIC_TYPE } from "../../topic/model.ts";

export function readLoopInput(store: Store, owner: import("@compforge/aide-plugin").ResourceRef, id: string | undefined, offset: number, history = false, maxChars?: number) {
  const inputs = owner.kind === "Route" ? store.topics.inputStore.query("routePending", "pending") : store.topics.pending(owner.uid!);
  const c = owner.kind === "Topic" ? store.resources.get<TopicSpec, TopicStatus>(TOPIC_TYPE, owner.name) : undefined;
  const members = c ? new Set(store.topics.scope(c.metadata.uid).map(t => t.metadata.uid)) : undefined;
  const status = (i: Readonly<Resource<InputSpec, InputStatus>>) => c ? i.status.assess : attemptOf(i, owner);
  if (!id) return { ...(c ? { context: { version: contentVersion(c), summary: summaryText(store.resources, c), summaryUid: summaryReference(store.resources, c)?.uid, summaryNote: summaryReference(store.resources, c), recent: notes(store.resources, c.metadata.uid, "subject"),
    maxChars } } : {}), inputs: inputs.slice(offset, offset + 20).map(i => ({ inputId: i.metadata.name, batchId: i.status.batchId, attention: inputAttention(i.spec), status: status(i) })),
    nextOffset: offset + 20 < inputs.length ? offset + 20 : null };
  const input = store.topics.inputStore.get(id);
  if (!input || (!inputs.some(i => i.metadata.name === id) && !(history && c &&
    (belongsToTopic(input, owner) || belongsToTopic(input, owner, members))))) throw new Error("Input is not attached to this resource");
  const description = inputPrinter.describe(input);
  return { inputId: id, batch: batchForInput(store.resources, input), attention: inputAttention(input.spec), status: status(input), text: description.slice(offset, offset + 8000), nextOffset: offset + 8000 < description.length ? offset + 8000 : null };
}
