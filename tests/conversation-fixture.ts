import { resourceHome } from "../src/host/resource/storage.ts";
import { randomUUID } from "node:crypto";
import { InputStore } from "../src/host/input/store.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { ConversationStore as PersonalConversations } from "../plugins/personal/conversation/store.ts";
import type { InputSpec } from "@compforge/aide-plugin";
import { initialConversationName } from "../plugins/personal/conversation/model.ts";
import type { Batch } from "../plugins/personal/conversation/batch.ts";
import type { Message } from "../plugins/personal/model.ts";
export function fixtureBatch(patch: Partial<Batch> = {}): Batch { return { id: "batch:fixture", inputIds: [], createdAt: new Date().toISOString(), context: { prompt: "fixture", history: "", responseRequired: false }, phase: "queued", messages: [], ...patch }; }
export class ConversationStore extends PersonalConversations {
  constructor(session: { dir: string; id?: string }) {
    const scope = { ...session, id: session.id ?? "test" };
    const resources = new PluginResourceStore({ session: scope, pluginInstanceId: "personal" });
    super(scope.id, resources, createResourceClient(resources, (change) => this.changed(change)), new InputStore(resourceHome(session.dir)));
  }
}
export async function seedInput(store: PersonalConversations, id: string, spec: InputSpec & { conversationId?: string }, status: Partial<Batch> = {}) {
  const { conversationId = spec.sessionId ?? store.sessionId, ...input } = spec;
  store.inputStore.submit(store.sessionId, id, input);
  const c = await store.ensure(conversationId);
  const resources = createResourceClient(store.resources, (change) => store.changed(change));
  const messages = status.messages ?? [];
  await resources.replace(c, { ...c.spec, name: c.spec.name || initialConversationName(input.text) }, { ...c.status,
    pendingInputIds: status.phase === "done" ? c.status.pendingInputIds : [...new Set([...c.status.pendingInputIds, id])],
    ...(status.phase ? { batch: fixtureBatch({ ...status, inputIds: [id], context: { prompt: input.text, history: "", responseRequired: input.origin === "channel" } }) } : {}),
    messages: [...c.status.messages, ...messages] });
  const fact = store.inputStore.get(id)!;
  store.inputStore.update(fact, { deliveries: [...new Set([...fact.status.deliveries ?? [], c.metadata.uid])], routing: fact.status.routing ?? { phase: "done", reason: "Fixture destination" } });
  return store.input(id, conversationId)!;
}

export async function confirmInBatch(scope: import("../plugins/personal/aide.ts").Personal, conversationId: string, prompt: string) {
  const c = scope.conversations.resource(conversationId)!;
  const batch = c.status.batch!;
  const { updateBatch } = await import("../plugins/personal/conversation/state.ts");
  await updateBatch(scope.plugins.resourceClient("personal"), c, batch.id, () => ({ phase: "waiting", communicated: true }));
  const result = await scope.plugins.executionVerbs(batch.executionId!, conversationId).confirm({ title: prompt, prompt, timeoutMs: 10000 });
  await updateBatch(scope.plugins.resourceClient("personal"), c, batch.id, () => ({ phase: "running" }));
  return result;
}
