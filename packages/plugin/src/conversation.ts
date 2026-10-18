/** Host-owned conversation/input projections; these are not Plugin-defined Resources. */
export const CONVERSATION_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Conversation" } as const;
export const INPUT_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Input" } as const;

export interface ConversationMessage {
  id: string;
  conversationId: string;
  at: string;
  role: "user" | "aide";
  text: string;
  workId: string | null;
}

/** Submission/view shape. Channel text is resolved from a Message reference in persistent storage. */
export interface InputSpec {
  conversationId: string;
  origin: "channel" | "source";
  text: string;
  timezone?: string;
  replyTo?: string;
  /** Source-owned observation, interpreted by the receiving Plugin. */
  observation?: Record<string, unknown>;
}

export interface InputQuestion {
  kind: "ask" | "confirm";
  title: string;
  prompt: string;
  choices?: Array<{ value: string; label: string }>;
}

export interface InputStatus {
  phase?: "running" | "waiting" | "done" | "failed";
  laneId?: string;
  question?: InputQuestion | null;
  error?: string;
  quietReason?: string;
  /** Projection of conversation messages belonging to this input. */
  messages?: ConversationMessage[];
}

export interface Conversation {
  id: string;
  revision: number;
  createdAt: string;
  pendingInputIds: string[];
  messages: ConversationMessage[];
}
