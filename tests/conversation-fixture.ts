import { assertChannelDelivery } from "../src/channel/address.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { personalAdmission } from "../plugins/personal/admission.ts";
import { fixtureAddress } from "./address-fixture.ts";
import personalDefinitions from "../plugins/personal/definitions.ts";
import type { Address } from "@compforge/aide-plugin";
import { InputStore } from "../plugins/personal/input/store.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { ConversationStore as PersonalConversations } from "../plugins/personal/conversation/store.ts";
import type { InputSpec } from "../plugins/personal/input/model.ts";
import { initialConversationName } from "../plugins/personal/conversation/model.ts";

import type { OutputDraft } from "../src/output.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { outputWrite } from "../plugins/personal/output.ts";
export interface FixtureProcessing { phase?: "queued" | "running" | "done" | "failed" | "interrupted"; executionId?: string; result?: { summary: string; error?: string }; }
export class ConversationStore extends PersonalConversations {
  readonly defaultConversationId: string;
  override ensure(id = this.defaultConversationId, address: Address = fixtureAddress(id)) { return super.ensure(id, address); }
  constructor(session: { dir: string; id?: string; home?: string }) {
    const scope = { ...session, id: session.id ?? "test", home: session.home ?? session.dir };
    const resources = new PluginResourceStore({ home: scope.home, pluginInstanceId: "personal" });
    resources.storage.register("personal", personalDefinitions);
    const outputStore = new OutputStore(scope.home, target => assertChannelDelivery(target, "app"));
    const provider = personalAdmission(new InputStore(scope.home), outputStore);
    super(resources, createResourceClient(resources, (change) => this.changed(change), undefined, provider), new InputStore(scope.home), outputStore);
    this.defaultConversationId = scope.id;
  }
}
export async function seedInput(store: PersonalConversations, id: string, spec: InputSpec & { conversationId?: string }, status: FixtureProcessing & { outputs?: Array<OutputDraft & { at: string }> } = {}) {
  const { conversationId = spec.sessionId ?? "test", ...input } = spec;
  if (input.origin === "channel" && !input.source) input.source = fixtureAddress(conversationId);
  store.inputStore.submit(spec.sessionId ?? "personal", id, input);
  const c = await store.ensure(conversationId, input.origin === "channel" ? input.source : undefined);
  const resources = createResourceClient(store.resources, (change) => store.changed(change));
  const outputs = status.outputs ?? [];
  for (const o of outputs) {
    const write = outputWrite(c, o);
    if (write.operation !== "create") continue;
    const resource = store.outputStore.create(conversationId, write.name, write.spec as import("../plugins/personal/output/model.ts").OutputSpec);
    const key = store.outputStore.key(o.id);
    const stored = store.outputStore.storage.read(key)!;
    store.outputStore.storage.write(key, "personal", { ...stored, object: { ...resource, metadata: { ...resource.metadata, creationTimestamp: o.at } } });
  }
  await resources.replace(c, { ...c.spec, name: c.spec.name || initialConversationName(input.text) }, { ...c.status,
    ...(status.phase === "running" ? { execution: { id: status.executionId ?? "fixture", startedAt: new Date().toISOString() } } : {}),

  });
  const fact = store.inputStore.get(id)!;
  store.inputStore.update(fact, { assess: { ...fact.status.assess, [c.metadata.uid]: {
    resource: resourceRef(c), assignedAt: new Date().toISOString(),
    ...(status.phase && status.phase !== "queued" ? { executionId: status.executionId ?? "fixture", startedAt: new Date().toISOString() } : {}),
    ...(status.phase === "done" ? { completedAt: new Date().toISOString(), result: { summary: status.result?.summary ?? "Done" } } : {}),
    ...(["failed", "interrupted"].includes(status.phase ?? "") ? { lastError: status.result?.error ?? "Interrupted" } : {}),
  } }, route: fact.status.route ?? { completedAt: new Date().toISOString(), result: { conversations: [resourceRef(c)], reason: "Fixture destination" } } });
  return store.input(id, conversationId)!;
}
