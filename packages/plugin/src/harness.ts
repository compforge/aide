/** Resource-owned provider selection and native recovery reference; never a live runtime object. */
export interface AgentStatus {
  readonly harness: string;
  readonly targetId: string;
  readonly session?: {
    readonly id: string;
    /** Adapter-owned locator only, never a transcript or checkpoint copy. */
    readonly resume?: { readonly version: number; readonly data: unknown };
  };
}
