export interface HarnessTaskIdentity {
  readonly contextId?: string;
  readonly harnessTargetId?: string;
  readonly harnessSessionId?: string;
  /** Harness-native identity, scoped to its context x HarnessTarget binding. */
  readonly taskId: string;
}

/**
 * Aide-stable key for a Harness task inside one HarnessStore.
 * Different context, HarnessTarget, or HarnessSession owners must remain distinct even when their
 * native taskId matches; Controller actions later use this key to recover the exact owner.
 */
export function harnessTaskKey(identity: HarnessTaskIdentity): string {
  return [
    "task",
    identity.contextId ?? "",
    identity.harnessTargetId ?? "",
    identity.harnessSessionId ?? "",
    identity.taskId,
  ].map(encodeURIComponent).join(":");
}
