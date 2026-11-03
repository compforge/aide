import { z } from "zod";
import { createHash } from "node:crypto";
import type { StreamRef } from "@compforge/aide-plugin";
import type { StreamStore } from "../../../src/host/stream/store.ts";
import { AGENT_STREAM_PROTOCOL, textEvent, readAgentStream, type AgentStreamEvent } from "../../../src/stream/agent.ts";
import { NOTE_TYPE, noteVersion, noteTextVersion, type NoteResource } from "../note/model.ts";
import { OUTPUT_TYPE, type Output, type OutputSubmission } from "../output/model.ts";
import type { OutputStore } from "../output/store.ts";

export type NoteCitation = { uid: string; version: string };
const MailContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().min(1), notes: z.array(z.object({ uid: z.string().min(1), version: z.string().min(1) }).strict()).max(100).optional() }).strict(),
  z.object({ kind: z.literal("agent") }).strict(),
]);
export type MailContent = { kind: "text"; text: string; notes?: readonly NoteCitation[] } | { kind: "agent" };
export type MailDraft = Omit<OutputSubmission, "stream"> & { content: MailContent };
/** @spec Personal generates mail and pins its evidence; Output only owns the delivery envelope.
 * @link docs/personal/output.md
 */
export class MailWriter {
  constructor(readonly streams: StreamStore, readonly ref: StreamRef) {}
  append(events: readonly AgentStreamEvent[]) { this.streams.append(this.ref, events); }
  cite(notes: readonly NoteCitation[]) {
    const references = notes.map(({ uid, version }) => {
      const note = this.streams.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, { namespace: "v1", limit: 1, matchIndex: { name: "uid", value: uid } }).items[0];
      return { ...NOTE_TYPE, uid, version, ...(note && noteVersion(note) === version ? { contentVersion: noteTextVersion(note) } : {}) };
    });
    this.streams.cite(this.ref, references);
  }
  close(error?: string) { if (error) this.streams.interrupt(this.ref, error); else this.streams.complete(this.ref); }
}
/** Creates both identities before publishing either one; no content path exists in OutputStore. */
export function composeMail(store: OutputStore, owner: string, id: string, draft: MailDraft): Output {
  return store.storage.transaction(() => {
    const { content: raw, ...intent } = draft;
    const content = MailContentSchema.parse(raw);
    if (content.kind === "text" && !content.text.trim()) throw new Error("Mail requires nonempty text");
    const digest = createHash("sha256").update(JSON.stringify(content)).digest("hex");
    const ref = store.streams.reference(`${id}-raw`, `stream:output:${id}:${digest}`);
    const previous = store.get(id);
    const output = store.create(owner, id, { ...intent, stream: ref });
    if (previous) return output;
    store.streams.create(ref, { ...OUTPUT_TYPE, namespace: output.metadata.namespace, name: id, uid: output.metadata.uid }, AGENT_STREAM_PROTOCOL);
    const writer = new MailWriter(store.streams, ref);
    if (content.kind === "text") { writer.cite(content.notes ?? []); writer.append([textEvent(content.text)]); writer.close(); }
    return output;
  });
}
export function replacementMail(store: OutputStore, output: Output, name: string, text: string): StreamRef {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const ref = store.streams.reference(`${output.metadata.name}-${name}-${hash}`, `stream:${output.metadata.uid}:${name}:${hash}`);
  return store.storage.transaction(() => {
    const stream = store.streams.create(ref, { ...OUTPUT_TYPE, namespace: output.metadata.namespace, name: output.metadata.name, uid: output.metadata.uid }, AGENT_STREAM_PROTOCOL);
    if (stream.status.phase === "open") { const writer = new MailWriter(store.streams, ref); writer.append([textEvent(text)]); writer.close(); }
    return ref;
  });
}
export function mailView(store: OutputStore, output: Output, actual = false) {
  return readAgentStream(store.streams.reader(actual && output.status.delivery ? output.status.delivery.stream : output.spec.stream), store.streams);
}
