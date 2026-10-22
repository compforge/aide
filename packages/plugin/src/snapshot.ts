export interface HarnessToolCall {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: string;
}

export interface HarnessExecutionResult {
  readonly stopReason?: string;
  readonly userText?: string;
  readonly agentText?: string;
  /** Harness-designated final answer; absent when the Harness did not identify one. */
  readonly finalText?: string;
  readonly toolCalls: readonly HarnessToolCall[];
  readonly usage?: Readonly<{
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    isEstimated?: boolean;
  }>;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

export interface HarnessTargetSnapshot {
  readonly id: string;
  readonly harness: string;
  readonly label?: string;
}

/** Configuration available to a reconciliation; execution history is never implicitly injected. */
export interface ReconcileSnapshot {
  readonly cwd?: string;
  readonly harnessTargets: readonly HarnessTargetSnapshot[];
}
