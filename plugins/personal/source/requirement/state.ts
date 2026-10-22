import type { RequirementIdentity, RequirementSummary, RequirementComment, RequirementPage } from "@compforge/aide-plugin";
import type { SourceInput } from "../input.ts";
export interface CommentWindow { start: string; end: string; cursor?: string; page?: RequirementPage<RequirementComment> }
export interface TrackedRequirement {
  identity: RequirementIdentity;
  fingerprint: string;
  retiring: boolean;
  baselineAt: string;
  commentsThrough: string;
  recent: Record<string, { fingerprint: string; at: string }>;
  window?: CommentWindow;
}
export interface RequirementScan { start?: string; end: string; cursor?: string; page?: RequirementPage<RequirementSummary> }
export interface RequirementSourceStatus {
  scope?: string;
  sequence?: number;
  tracked?: Record<string, TrackedRequirement>;
  scan?: RequirementScan | null;
  scannedThrough?: string | null;
  pending?: { name: string; spec: SourceInput; key: string; entry: TrackedRequirement } | null;
  lastObservedAt?: string;
  error?: string | null;
}
