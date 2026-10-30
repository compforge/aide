import type { ResourceContext } from "../context.ts";
import type { Resource, Address, ResourceRef } from "@compforge/aide-plugin";
import type { InputSpec, InputStatus } from "../input/model.ts";
import type { OutputView } from "../../../src/output.ts";
import type { LoopExecution } from "../loop.ts";
import type { TopicReview } from "./review.ts";
export const TOPIC_TYPE = { apiVersion: "aide.dev/v1alpha3", kind: "Topic" } as const;
export const DEFAULT_TOPIC_ID = "default";
export interface TopicSpec { address?: Address; id: string; name?: string; default?: boolean; review?: TopicReview;
  topicKey?: string; parentRef?: ResourceRef & { uid: string } }
export interface TopicStatus extends ResourceContext {
  noteReviewQueue?: Array<{ noteId: string; version: string }>;
  reclamation?: { version: string; reason: string; writer: import("../note/model.ts").NoteStatus["writer"] };
  assignmentRefresh?: { version: string; cursor: string; complete: boolean };
  summaryDependencies?: Record<string, string>;
  conditions?: import("../conditions.ts").Condition[];
  organization?: import("./ref.ts").Organization;
  lastInputAt?: string;
  /** Notification progress belongs to the Topic, not to its Input material. */
  weaveRevision?: number;
  notifiedWeaveRevision?: number;
  lastError?: string | null;
  absorbed?: Record<string, string>;
  absorbedSummaries?: Record<string, string>;
  agent?: import("@compforge/aide-plugin").AgentStatus;
  nextAbsorbAt?: string;
  absorbAttempts?: number;
  /** Capacity maintenance has its own clock and yields one activation to waiting business material. */
  capacityRequests?: Partial<Record<"aide:triage" | "aide:organize", { checkedAt: string; inputId: string }>>;
  yieldToInput?: boolean;
  reviewCheckedAt?: string | null;
  idleReviewCount?: number;
  idleReviewReset?: { at: string; previousCount: number } | null;
  idleSince?: string;
  execution?: LoopExecution | null;
  receipts: Array<{ key: string; responseId: string }>;
}
export type TopicResource = Resource<TopicSpec, TopicStatus>;
export type TopicDeletionBlock = "busy" | "work" | "default" | "children" | "unabsorbed";
export type TopicDeletion = { deleted: true } | { deleted: false; reason: "missing" | "changed" | TopicDeletionBlock };
/** The transactional validator owns deletion rules; callers can present expected refusals without duplicating them. */
export class TopicDeletionBlocked extends Error {
  constructor(readonly reason: TopicDeletionBlock, message: string) { super(message); }
}
export interface Topic extends TopicSpec {
  revision: number; createdAt: string; pendingInputIds: string[]; outputs: OutputView[];
}
/** Presentation only: never overwrite an Input's resource version or routing status with Topic state. */
export interface Consumption { phase?: "running" | "done" | "failed"; executionId?: string; summary?: string; error?: string }
export type TopicInput = Resource<InputSpec, InputStatus> & { topicId: string; consumption: Consumption };
export interface TopicRun { id: string; topicId: string; input?: TopicInput; status: Consumption }
export function initialTopicName(text: string): string { return text.replace(/\s+/g, " ").trim().slice(0, 80); }
