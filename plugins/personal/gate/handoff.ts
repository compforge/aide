import { externalActivity } from "../topic/activity.ts";
import { inputClassification } from "../disclosure.ts";
import { resourceRef } from "../input/state.ts";
import { isGateTopic, isRootTopic } from "../topic/boundary.ts";
import { TOPIC_TYPE, type TopicResource } from "../topic/model.ts";
import type { Store } from "../work/store.ts";
import { isGateInput } from "./input.ts";

/** @spec One authorized Gate Input is forwarded once per root Topic, including retries after payload eviction.
 * @link docs/personal/gate.md
 */
export function appendGateInput(store: Store, gate: TopicResource, args: { inputId: string; topicUid: string; text: string }) {
  const inputs = store.topics.inputStore;
  return inputs.storage.transaction(() => {
    const source = inputs.get(args.inputId);
    const active = store.topics.byRef(resourceRef(gate));
    if (!active || !isGateTopic(active) || !active.status.execution || active.status.execution.id !== gate.status.execution?.id ||
        !source || source.metadata.deletionTimestamp || source.status.topic?.uid !== gate.metadata.uid || !isGateInput(source.spec) || !source.spec.source)
      throw new Error("Gate handoff requires an original user Input in the active Gate");
    const topic = store.resources.page<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE,
      { limit: 1, matchIndex: { name: "uid", value: args.topicUid } }).items[0];
    if (!topic || topic.metadata.deletionTimestamp || !isRootTopic(topic)) throw new Error("Choose an available root Topic");
    const target = resourceRef(topic);
    const inputKey = JSON.stringify(["aide:handoff", source.metadata.uid, topic.metadata.uid]);
    const input = inputs.submit(topic.spec.id, inputKey, {
      inputKey, origin: "aide:handoff", originId: "personal.gate", topicId: topic.spec.id, text: args.text,
      handoff: { gate: resourceRef(gate), sourceInput: resourceRef(source) },
      source: source.spec.source, sender: source.spec.sender, replyToMessageId: source.spec.replyToMessageId,
      observation: { originalText: source.spec.text }, ...inputClassification(source.spec),
    }, { topic: target, assess: {}, route: { completedAt: new Date().toISOString(), result: { topics: [target], reason: "Gate handoff" } } });
    if (input.status.topic && (!topic.status.lastInputAt || input.metadata.creationTimestamp > topic.status.lastInputAt))
      store.resources.patchStatus(TOPIC_TYPE, topic.metadata.name, externalActivity(topic, input.metadata.creationTimestamp));
    return { inputId: input.metadata.name, topicId: topic.spec.id };
  });
}
