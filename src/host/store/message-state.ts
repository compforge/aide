import type { SubmitDelivery } from "../event/index.ts";
import type { Input, Output, InputRequest, InputResponse } from "../message/types.ts";

/** Execution associations belong to the Harness projection, not Message identity. */
export interface MessageExecution {
  invocationId?: string;
  runtimeId?: string;
  harness?: string;
  harnessName?: string;
}

export interface InputState extends Input, MessageExecution {
  delivery?: SubmitDelivery;
  deliveryState?: "pending" | "applied" | "failed" | "uncertain";
  consumedAt?: number;
}

export type OutputState = Output & MessageExecution;
export type InputRequestState = InputRequest & MessageExecution;
export type InputResponseState = InputResponse & MessageExecution;
export type ProjectedMessage = InputState | OutputState | InputRequestState | InputResponseState;
