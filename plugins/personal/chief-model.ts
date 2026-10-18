import { createHash } from "node:crypto";
import type { Message } from "./model.ts";
import type { RequirementSummary } from "../../connectors/requirements/protocol.ts";
import type { Watch } from "./source-config.ts";

export const CHIEF_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "ChiefInput" } as const;
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const chiefTarget = (conversationId: string) => `chief:${digest(conversationId)}`;
export interface ChiefSpec {
  conversationId: string;
  text: string;
  origin: "channel" | "source";
  replyTo?: string;
  timezone?: string;
  discovery?: { watch: Watch; requirement: RequirementSummary };
}
export interface ChiefQuestion {
  kind: "ask" | "confirm";
  title: string;
  prompt: string;
  choices?: Array<{ value: string; label: string }>;
}
export interface ChiefStatus {
  phase?: "running" | "waiting" | "done" | "failed";
  laneId?: string;
  question?: ChiefQuestion | null;
  messages?: Message[];
  error?: string;
  quietReason?: string;
}
