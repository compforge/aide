/** Stable native identity. Harness owns persistence and resolves this ID after restart. */
export interface AgentStatus {
  readonly harness: string;
  readonly sessionId?: string;
}
