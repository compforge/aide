import type { Resource, ResourceRef } from "./resource.ts";

export const STREAM_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Stream" } as const;
export type StreamRef = ResourceRef & { uid: string };
/** The protocol owner interprets records; the store only persists ordered JSON. */
export interface StreamEvent { kind: string; payload: unknown }
export interface StreamRecord extends StreamEvent { seq: number }
export interface StreamReference { apiVersion: string; kind: string; uid: string; version: string; contentVersion?: string }
export interface StreamStatus {
  phase: "open" | "completed" | "interrupted";
  lastSeq: number;
  references: StreamReference[];
  closedAt?: string;
  error?: string;
}
/** @spec Stream identity and references belong to one owner; closed mail is immutable.
 * @link docs/plugin/stream.md
 */
export type Stream = Resource<{ protocol: string }, StreamStatus>;
/** A read handle is pinned to a committed tail, never to future records. */
export interface StreamReader {
  ref: StreamRef;
  protocol: string;
  status: StreamStatus;
  read(afterSeq?: number, limit?: number): StreamRecord[];
}
