/** Actual execution binding. Native history and recovery belong to the Harness. */
export interface AgentStatus {
  readonly harness: string;
  readonly targetId: string;
  readonly session?: {
    readonly id: string;
    /** Adapter-owned locator only, never a transcript or checkpoint copy. */
    readonly resume?: { readonly version: number; readonly data: unknown };
  };
}
