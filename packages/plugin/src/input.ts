export const INPUT_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Input" } as const;
export interface InputSpec {
  /** Optional destination scope supplied by the producer, not the Input execution owner. */
  sessionId?: string;
  origin: "channel" | "source";
  text: string;
  timezone?: string;
  replyTo?: string;
  observation?: Record<string, unknown>;
}
/** Routing state belongs to the consuming plugin; the Core persists it without interpreting destinations. */
export interface InputStatus {
  routing?: { phase: "planned" | "done" | "ignored"; targets: Array<{ sessionId: string; name: string; uid: string }>; reason: string };
}
