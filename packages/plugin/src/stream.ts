import type { Resource, ResourceRef } from "./resource.ts";

export const STREAM_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Stream" } as const;
export type StreamRef = ResourceRef & { uid: string };
export interface StreamDelta { kind: "think" | "text"; delta: string }
export interface StreamChunk extends StreamDelta { seq: number }
export interface StreamStatus {
  phase: "open" | "completed" | "interrupted";
  lastSeq: number;
  closedAt?: string;
  error?: string;
}
/** @spec Content is append-only and stored separately; the resource owner controls its lifetime.
 * @link docs/plugin/stream.md
 */
export type Stream = Resource<Record<string, never>, StreamStatus>;
export interface StreamSnapshot extends StreamStatus { think: string; text: string }
