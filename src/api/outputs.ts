import type { ResourceRef, Resource } from "@compforge/aide-plugin";
import type { WebService } from "./service.ts";
import { browseOutputs, outputFacets, type OutputBrowseQuery } from "../../plugins/personal/output/browse.ts";
import { outputWaitLabels } from "../../plugins/personal/output/view.ts";
import { outputPrinter } from "../../plugins/personal/output/printer.ts";
import type { Output } from "../../plugins/personal/output/model.ts";

/** Resolve exact retained identities; a replacement resource must never inherit an old Output link. */
function reference(aide: WebService, ref: ResourceRef) {
  const current = aide.topics.resources.storage.read(aide.topics.resources.key(ref, ref.name, ref.namespace))?.object as Resource<Record<string, unknown>, unknown> | undefined;
  const available = !!current && current.metadata.uid === ref.uid && !current.metadata.deletionTimestamp;
  const spec = available ? current.spec : undefined;
  const label = spec && [spec.name, spec.title, spec.id].find(v => typeof v === "string");
  let href: string | undefined;
  if (available) {
    if (ref.kind === "Topic" && typeof spec?.id === "string") href = '/?' + new URLSearchParams({ topic: spec.id });
    if (ref.kind === "Person") href = '/people?' + new URLSearchParams({ person: ref.name, uid: ref.uid! });
    if (ref.kind === "Address") href = '/addresses?' + new URLSearchParams({ name: ref.name, uid: ref.uid! });
  }
  return { ref, label: typeof label === "string" ? label : ref.name, available, href };
}
function summary(aide: WebService, output: Output) {
  const { metadata, spec, status } = output;
  const wait = ["pending", "sending"].includes(status.phase) ? status.deliveryWait : undefined;
  return { id: metadata.name, uid: metadata.uid, at: metadata.creationTimestamp, preview: aide.topics.outputStore.content(output, true).text.replace(/\s+/gu, " ").slice(0, 120) || outputPrinter.summarize(output),
    topic: reference(aide, spec.topic), receivers: [...(spec.receivers ?? [])].map(ref => reference(aide, ref)),
    address: reference(aide, spec.target), actualAddress: status.delivery && reference(aide, status.delivery.address),
    phase: status.phase, disclosure: status.disclosure?.decision ?? "pending" as const,
    wait: wait && { ...wait, label: outputWaitLabels[wait.reason] }, attempts: status.attempts, lastError: status.lastError,
    deliveredAt: status.deliveredAt };
}
export function outputList(aide: WebService, query: OutputBrowseQuery) {
  const result = browseOutputs(aide.topics.outputStore, query);
  return { ...result, items: result.items.map(output => summary(aide, output)) };
}
export function outputFilters(aide: WebService) {
  const facets = outputFacets(aide.topics.outputStore);
  const options = (refs: ResourceRef[]) => [...new Map(refs.map(ref => [ref.uid!, reference(aide, ref)])).values()]
    .map(item => ({ value: item.ref.uid!, label: `${item.label}${item.available ? "" : "（已删除或不可用）"}` }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  return { topics: options(facets.topics), receivers: options(facets.receivers), addresses: options(facets.addresses) };
}
/**
 * @spec Original intent and actual delivery remain separate; current state is not a historical attempt log.
 * @link docs/personal/output.md#web-查询
 */
export function outputDetail(aide: WebService, id: string, uid?: string) {
  const store = aide.topics.outputStore;
  const output = store.storage.read(store.key(id))?.object as Output | undefined;
  if (!output || output.metadata.deletionTimestamp || (uid !== undefined && uid !== output.metadata.uid)) return;
  const { spec, status } = output;
  return { ...summary(aide, output), text: store.content(output).text, think: store.content(output).think, stream: { ref: spec.stream, ...store.content(output) }, target: spec.target, disclosureDetail: status.disclosure,
    delivery: status.delivery && { ...status.delivery, text: store.content(output, true).text, think: store.content(output, true).think, streamStatus: store.content(output, true), receivers: [...status.delivery.receivers].map(ref => reference(aide, ref)) },
    receipt: status.receipt, producer: spec.producer ? reference(aide, spec.producer) : spec.executionId || spec.createdBy ? reference(aide, spec.topic) : undefined, executionId: spec.executionId,
    createdBy: spec.createdBy, notes: spec.notes ?? [], inputs: (spec.inputIds ?? []).map(id => {
      const uid = spec.inputUids?.[id], store = aide.topics.inputStore;
      const input = store.storage.read(store.key(id))?.object;
      const available = !!uid && input?.metadata.uid === uid && !input.metadata.deletionTimestamp;
      return { id, uid, available, href: available ? '/inputs?' + new URLSearchParams({ input: id, uid }) : undefined };
    }) };
}
export async function outputSession(aide: WebService, id: string, uid: string) {
  const store = aide.topics.outputStore;
  const output = store.storage.read(store.key(id))?.object as Output | undefined;
  if (!output || output.metadata.uid !== uid || output.metadata.deletionTimestamp || !output.spec.createdBy || !aide.readSession) return;
  const agent = output.spec.createdBy.agent, view = await aide.readSession(agent);
  if (view.session.id !== agent.sessionId) throw new Error("Session identity mismatch");
  return view;
}
