/** Parameters for calling a Harness again. Callers choose whether and where to persist them. */
export interface AgentStatus {
  readonly harness: string;
  readonly session?: {
    readonly id: string;
    /** Adapter-owned locator only, never a transcript or checkpoint copy. */
    readonly resume?: { readonly version: number; readonly data: unknown };
  };
}
