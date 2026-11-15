import { ensureGateTopic } from "../plugins/personal/gate/topic.ts";
import { TOPIC_TYPE, GATE_TOPIC_ID } from "../plugins/personal/topic/model.ts";
import { digest } from "../plugins/personal/chief-model.ts";
import { NoteDefinition } from "../plugins/personal/note/definition.ts";
import type { Resource, ResourceClient, ResourceType } from "@compforge/aide-plugin";
import type { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { NOTE_TYPE, noteVersion } from "../plugins/personal/note/model.ts";
import { writeSummary } from "../plugins/personal/note/summary.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";

// Fixture builders express knowledge as text while exercising the production Note writer.
export async function patchSummary(client: ResourceClient, resource: any, patch: any) {
  const { summary, ...rest } = patch;
  const current = Object.keys(rest).length ? await client.patchStatus(resource, rest) : resource;
  return writeSummary(client, current, { text: summary });
}
export async function createWithSummary<S = any, T = any>(client: ResourceClient, type: ResourceType, init: any): Promise<Resource<S, T>> {
  const { summary, ...status } = init.status;
  const spec = type.kind === TOPIC_TYPE.kind && init.spec.id !== GATE_TOPIC_ID && !init.spec.parentRef
    ? { ...init.spec, parentRef: resourceRef(await ensureGateTopic(client)) } : init.spec;
  const resource = await client.create(type, { ...init, spec, status });
  return await writeSummary(client, resource as any, { text: summary }) as Resource<S, T>;
}
export function seedSummaryPatch(store: PluginResourceStore, type: ResourceType, name: string, patch: any) {
  store.storage.register("personal", [NoteDefinition]);
  return store.storage.transaction(() => {
    const current = store.get<any, any>(type, name), text = patch.summary;
    let summaryRevision = current.status.summaryRevision ?? "";
    if (text || summaryRevision) {
      const noteName = `summary-${current.metadata.uid}`;
      const previous = store.find<any, any>(NOTE_TYPE, noteName);
      const spec = { subject: resourceRef(current), summaryOf: resourceRef(current), people: previous?.spec.people ?? [], text };
      const status = { updatedAt: new Date().toISOString() };
      const note = previous ? store.replace(NOTE_TYPE, noteName, spec, status, { expectedResourceVersion: previous.metadata.resourceVersion })
        : store.create({ type: NOTE_TYPE, name: noteName, spec, status });
      summaryRevision = noteVersion(note as any);
    }
    const { summary: _, ...rest } = patch;
    return store.patchStatus<any, any>(type, name, { ...rest, summaryRevision });
  });
}
export function createWithSummarySync(store: PluginResourceStore, init: any) {
  const { summary, ...status } = init.status;
  const spec = init.type.kind === TOPIC_TYPE.kind && init.spec.id !== GATE_TOPIC_ID && !init.spec.parentRef
    ? { ...init.spec, parentRef: fixtureGateRef(store) } : init.spec;
  const resource = store.create({ ...init, spec, status });
  return seedSummaryPatch(store, init.type, resource.metadata.name, { summary: init.status.summary });
}

export function fixtureGateRef(store: PluginResourceStore) {
  const gate = store.find(TOPIC_TYPE, digest(GATE_TOPIC_ID)) ?? store.create({ type: TOPIC_TYPE, name: digest(GATE_TOPIC_ID),
    spec: { id: GATE_TOPIC_ID, name: "Gate", review: { enabled: false } }, status: { receipts: [] } });
  return resourceRef(gate);
}
