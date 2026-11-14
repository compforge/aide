import type { TopicStore } from "../../plugins/personal/topic/store.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "../../plugins/personal/topic/model.ts";
import { addressRef, type AddressRef } from "../../plugins/personal/address/model.ts";
import type { Addresses } from "../../plugins/personal/address/service.ts";
import type { OutputMessage } from "../../plugins/personal/output/delivery.ts";

/**
 * @spec Links to the private Web process are emitted only for a verified private Me destination, never for a group or an unknown audience.
 * @spec Deep links pin the conversation incarnation and the Output's actual execution, including Chief replies returned to Gate.
 * @link docs/channel/lark.md#过程反馈与最终答复
 */
export function processLink(topics: TopicStore, addresses: Pick<Addresses, "find">,
  privateMe: (ref: AddressRef) => boolean, baseUrl?: string) {
  return async (message: OutputMessage): Promise<string | undefined> => {
    if (!baseUrl) return;
    const address = addresses.find(message.target);
    if (!address || address.spec.type !== "direct") return;
    if (!privateMe(addressRef(address))) return;
    const output = topics.outputStore.get(message.id);
    if (!output?.spec.executionId) return;
    const ref = output.spec.conversation ?? output.spec.topic;
    const topic = topics.resources.find<TopicSpec, TopicStatus>(TOPIC_TYPE, ref.name, ref.namespace);
    if (!topic || topic.metadata.uid !== ref.uid || topic.metadata.deletionTimestamp) return;
    const url = new URL(topic.spec.id === "gate" ? "/gate" : "/", baseUrl);
    if (topic.spec.id !== "gate") url.searchParams.set("topic", topic.spec.id);
    url.searchParams.set("process", output.spec.executionId); url.searchParams.set("processTopicUid", ref.uid);
    return url.toString();
  };
}
