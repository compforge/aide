import { fixtureAddress } from "./address-fixture.ts";
import type { Address } from "@compforge/aide-plugin";
import { resourceHome } from "../src/host/resource/storage.ts";
import { randomUUID } from "node:crypto";
import { InputStore } from "../src/host/input/store.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { ConversationStore as PersonalConversations } from "../plugins/personal/conversation/store.ts";
import type { InputSpec } from "@compforge/aide-plugin";
import { initialConversationName } from "../plugins/personal/conversation/model.ts";
import type { Batch } from "../plugins/personal/conversation/batch.ts";
import type { OutputDraft } from "../src/output.ts";
import { OutputStore } from "../src/host/output/store.ts";
import { outputWrite } from "../plugins/personal/output.ts";
export function fixtureBatch(patch: Partial<Batch> = {}): Batch { return { id: "batch:fixture", inputIds: [], createdAt: new Date().toISOString(), context: { prompt: "fixture", history: "", responseRequired: false }, phase: "queued", outputIds: [], ...patch }; }
export class ConversationStore extends PersonalConversations {
  override ensure(id = this.sessionId, address: Address = fixtureAddress(id)) { return super.ensure(id, address); }
  constructor(session: { dir: string; id?: string }) {
    const scope = { ...session, id: session.id ?? "test" };
    const resources = new PluginResourceStore({ session: scope, pluginInstanceId: "personal" });
    const outputStore = new OutputStore(resourceHome(session.dir));
    const provider = { handles: (type: { kind: string }) => type.kind === "Output", create: <S, T>(_type: unknown, name: string, spec: S) => outputStore.create(scope.id, name, spec as import("@compforge/aide-plugin").OutputSpec) as unknown as import("@compforge/aide-plugin").Resource<S, T>,
      get: <S, T>(ref: { name: string }) => outputStore.get(ref.name) as unknown as import("@compforge/aide-plugin").Resource<S, T> | undefined,
      list: <S, T>() => outputStore.list() as unknown as import("@compforge/aide-plugin").Resource<S, T>[], patch: () => { throw new Error("unsupported"); } };
    super(scope.id, resources, createResourceClient(resources, (change) => this.changed(change), undefined, provider), new InputStore(resourceHome(session.dir)), outputStore);
  }
}
export async function seedInput(store: PersonalConversations, id: string, spec: InputSpec & { conversationId?: string }, status: Partial<Batch> & { outputs?: Array<OutputDraft & { at: string }> } = {}) {
  const { conversationId = spec.sessionId ?? store.sessionId, ...input } = spec;
  if (input.origin === "channel" && !input.source) input.source = fixtureAddress(conversationId);
  store.inputStore.submit(store.sessionId, id, input);
  const c = await store.ensure(conversationId, input.origin === "channel" ? input.source : undefined);
  const resources = createResourceClient(store.resources, (change) => store.changed(change));
  const outputs = status.outputs ?? [];
  const { outputs: _outputs, ...batch } = status;
  for (const o of outputs) {
    const write = outputWrite(c, o);
    if (write.operation !== "create") continue;
    const resource = store.outputStore.create(store.sessionId, write.name, write.spec as import("@compforge/aide-plugin").OutputSpec);
    const key = `output:${o.id}`;
    const stored = store.outputStore.storage.read(key)!;
    store.outputStore.storage.write(key, "core", { ...stored, object: { ...resource, metadata: { ...resource.metadata, creationTimestamp: o.at } } });
  }
  await resources.replace(c, { ...c.spec, name: c.spec.name || initialConversationName(input.text) }, { ...c.status,
    pendingInputIds: status.phase === "done" ? c.status.pendingInputIds : [...new Set([...c.status.pendingInputIds, id])],
    ...(status.phase ? { batch: fixtureBatch({ ...batch, outputIds: outputs.map((o) => o.id), inputIds: [id], context: { prompt: input.text, history: "", responseRequired: input.origin === "channel" } }) } : {}),
  });
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
