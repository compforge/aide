import type { Resource } from "@compforge/aide-plugin";
import { WorkSchema, type Work, type Message } from "./model.ts";
export const WORK_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Work" } as const;
export const CONVERSATION_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Conversation" } as const;
export type WorkSpec = Pick<Work, "conversationId" | "kind" | "title" | "instruction" | "trigger" | "revision">;
type WorkObservation = Omit<Work, keyof WorkSpec | "id">;
export interface Delivery {
  messages: Message[];
  inputs: Array<{ key: string; responseId: string }>;
  events: string[];
}
export type WorkStatus = WorkObservation & Delivery & { laneId?: string };
export type WorkResource = Resource<WorkSpec, WorkStatus>;

export function toWork(resource: WorkResource): Work {
  const { messages: _messages, inputs: _inputs, events: _events, laneId: _lane, ...observation } = resource.status;
  return WorkSchema.parse({ id: resource.metadata.name, ...resource.spec, ...observation });
}


export const INTAKE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Intake" } as const;
