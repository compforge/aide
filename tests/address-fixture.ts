import { Addresses } from "../plugins/personal/address/service.ts";
import { addressRef } from "../plugins/personal/address/model.ts";
import type { ChannelAddress } from "@compforge/aide-plugin";
import { larkAddress, webAddress } from "../src/channel/address.ts";

/** Legacy fixture IDs encode their intended transport; production never uses this decoder. */
export function fixtureAddress(id: string): ChannelAddress {
  const match = /^lark:([^:]+):(.+)$/.exec(id);
  return match ? larkAddress(match[1]!, match[2]!) : webAddress(id);
}
export function fixtureIncoming<T extends { channelId?: string; topicId: string }>(input: T): T & { source: ChannelAddress } {
  return { source: input.channelId === "web" ? webAddress(input.topicId) : fixtureAddress(input.topicId), ...input };
}

/** Explicit permission for tests that exercise transport after policy checking. */
export function allowAddress(home: string, target: import("../plugins/personal/address/service.ts").AddressTarget) {
  const addresses = new Addresses(home), address = addresses.observe(target);
  if (address.spec.muted) addresses.setMuted(addressRef(address), false, true);
}

export function addressFor(home: string, endpoint: import("@compforge/aide-plugin").Address) {
  return new Addresses(home).ref(endpoint);
}
export const fixtureCanSpeak = (home: string) => (target: import("@compforge/aide-plugin").Address) => new Addresses(home).canSpeak(target);

/** Initialize the configured Me inbox without starting background controllers in routing-only tests. */
export async function fixtureMe(aide: import("../src/app.ts").Aide) {
  await aide.persons.initialize();
  const { personRef, LOCAL_ME } = await import("../plugins/personal/person/model.ts");
  const me = (await aide.persons.findIdentity(LOCAL_ME))!;
  aide.addresses.observe(webAddress("me"), [personRef(me)], { type: "web", muted: false });
  return personRef(me);
}

/** Inject an already assigned domain Channel fact below Me/Gate ingress, for Chief execution tests. */
export async function receiveDomain(aide: import("../src/app.ts").Aide, input: import("../src/channel/message.ts").Incoming) {
  const { digest } = await import("../plugins/personal/chief-model.ts");
  const { InputAttention } = await import("../plugins/personal/input/model.ts");
  const { initialTopicName } = await import("../plugins/personal/topic/model.ts");
  const { resourceRef } = await import("../plugins/personal/input/state.ts");
  await aide.start();
  const id = digest([input.channelId, input.topicKey ?? input.topicId ?? "", input.id]);
  const prior = aide.topics.inputStore.get(id), receipt = aide.topics.inputStore.receipt(id);
  if (prior || receipt) return { inputId: id, at: prior?.metadata.creationTimestamp ?? receipt!.at };
  const sender = await fixtureMe(aide);
  aide.addresses.observe(input.source, [sender], { type: "web", muted: false });
  const topic = await aide.topics.ensure(input.topicId!, input.source, initialTopicName(input.topicName ?? input.text));
  const { id: _id, channelId, ...spec } = input;
  const fact = aide.topics.inputStore.submit(input.topicId!, id, { ...spec, sender, origin: "channel", originId: channelId, attention: InputAttention.Immediate },
    { topic: resourceRef(topic), assess: {}, route: { completedAt: new Date().toISOString(), result: { topics: [resourceRef(topic)], reason: "Domain execution fixture" } } });
  return { inputId: fact.metadata.name, at: fact.metadata.creationTimestamp };
}
