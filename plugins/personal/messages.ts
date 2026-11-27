import type { ApplicationMessage } from "@compforge/aide-plugin";
import type { Input } from "./input/state.ts";
import type { InputSpec } from "./input/model.ts";

type InputMaterial = Pick<InputSpec, "origin" | "originId" | "source" | "sender" | "relation"> & { id: string; uid: string };
export type InputMessage = {
  content: string;
  customType: "aide.input";
  details: { deliveryId: string; inputs: InputMaterial[]; batchId?: string };
};

type SnapshotMessage<K extends string, D> = { customType: `aide.${K}`; content: string; details: D & { kind: K } };
type WorkIdentity = { uid: string; version?: string | number };
export type TopicMessage = SnapshotMessage<"topic", { uid: string; version?: string }>;
export type NoteMessage = SnapshotMessage<"note", { uid: string; version: string }>;
export type TaskMessage = SnapshotMessage<"task", WorkIdentity>;
export type RoutineMessage = SnapshotMessage<"routine", WorkIdentity>;
export type OngoingMessage = SnapshotMessage<"ongoing", WorkIdentity>;
export type WorkMessage = TaskMessage | RoutineMessage | OngoingMessage;
type Snapshot = TopicMessage | NoteMessage | WorkMessage;

/** @spec One admission can deliver a sealed Batch. Its business identity is independent of each source Input. */
export function inputMessage(content: string, deliveryId: string, inputs: readonly Input[], batchId?: string): InputMessage {
  return { customType: "aide.input", content, details: { deliveryId, ...(batchId && { batchId }),
    inputs: inputs.map(({ metadata, spec }) => ({ id: metadata.name, uid: metadata.uid, origin: spec.origin,
      originId: spec.originId, source: spec.source, sender: spec.sender, relation: spec.relation })) } };
}

export function snapshotMessage<D extends Snapshot["details"]>(details: D, content: string) {
  return { customType: `aide.${details.kind}` as const, details, content };
}

/** Keep the model projection available to every Harness; Pi also retains the application identity. */
export function messagePrompt({ content, ...message }: ApplicationMessage & { content: string }) {
  return { prompt: content, message };
}

/** @spec Pi retains the native toolCallId and the observed body; details identify that same snapshot. */
export function snapshotResult(snapshot: Snapshot["details"], body: unknown) {
  const { content, ...details } = snapshotMessage(snapshot, JSON.stringify(body));
  return { content: [{ type: "text" as const, text: content }], details };
}

export function noteResult<T extends { uid: string; version: string }>(note: T) {
  return snapshotResult({ kind: "note", uid: note.uid, version: note.version }, note);
}
