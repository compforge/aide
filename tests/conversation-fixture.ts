import { randomUUID } from "node:crypto";
import { InputStore } from "../src/host/input/store.ts";
import { PluginResourceStore } from "../src/host/plugin/resource.ts";
import { createResourceClient } from "../src/host/plugin/resource-client.ts";
import { ConversationStore as PersonalConversations } from "../plugins/personal/conversation-store.ts";
import type { InputSpec } from "@compforge/aide-plugin";
import type { ProcessingStatus } from "../plugins/personal/conversation-model.ts";
export class ConversationStore extends PersonalConversations {
  constructor(session: { dir: string; id?: string }) {
    const scope = { ...session, id: session.id ?? "test" };
    const resources = new PluginResourceStore({ session: scope, pluginInstanceId: "personal" });
    super(scope.id, resources, createResourceClient(resources, (change) => this.changed(change)), new InputStore(session.dir));
  }
}
export async function seedInput(store: PersonalConversations, id: string, spec: InputSpec & { conversationId?: string }, status: ProcessingStatus = {}) {
  const { conversationId = spec.sessionId ?? store.sessionId, ...input } = spec;
  store.inputStore.submit(store.sessionId, id, input);
  const c = await store.ensure(conversationId);
  if (!c.spec.inputIds.includes(id)) {
    const inbound = input.origin === "channel" ? { id: `inbound:${id}`, conversationId, at: new Date().toISOString(), role: "user" as const, text: input.text, workId: null } : undefined;
    const messages = status.messages ?? (inbound ? [inbound] : []);
    const resources = createResourceClient(store.resources, (change) => store.changed(change));
    await resources.replace(c, { ...c.spec, inputIds: [...c.spec.inputIds, id] }, { ...c.status, processing: { ...c.status.processing, [id]: { ...status, messages } }, messages: [...c.status.messages, ...messages] });
  }
  const fact = store.inputStore.get(id)!;
  if (!fact.status.routing) store.inputStore.update(fact, { routing: { phase: "done", targets: [{ sessionId: store.sessionId, name: c.metadata.name, uid: c.metadata.uid }], reason: "Fixture destination" } });
  return store.input(id, conversationId)!;
}
