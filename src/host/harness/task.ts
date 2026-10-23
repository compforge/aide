export interface HarnessTaskIdentity {
  readonly runtimeId?: string;
  readonly harnessName?: string;
  readonly harnessSessionId?: string;
  /** Harness-native identity, scoped to its context x HarnessConfiguration binding. */
  readonly taskId: string;
}

/**
 * Aide-stable key for a Harness task inside one live execution projection.
 * Different context, HarnessConfiguration, or HarnessSession owners must remain distinct even when their
 * native taskId matches; Controller actions later use this key to recover the exact owner.
 */
export function harnessTaskKey(identity: HarnessTaskIdentity): string {
  return [
    "task",
    identity.runtimeId ?? "",
    identity.harnessName ?? "",
    identity.harnessSessionId ?? "",
    identity.taskId,
  ].map(encodeURIComponent).join(":");
}
