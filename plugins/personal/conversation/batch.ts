/** @spec A Batch fixes its inputs and prompt before execution. Only execution state and its result may change.
 * @spec One Conversation holds at most one Batch; completed context is transferred before replacement.
 * @link docs/plugin/personal.md
 */
export interface Batch {
  id: string;
  inputIds: string[];
  context: { prompt: string; history: string; responseRequired: boolean };
  createdAt: string;
  timerAt?: string;
  phase: "queued" | "running" | "compacting" | "done" | "failed" | "interrupted";
  executionId?: string;
  deadline?: string;
  cancelRequested?: boolean;
  failureStage?: "execution" | "compaction";
  communicated?: boolean;
  quietReason?: string;
  outputIds: string[];
  result?: { summary: string; outputs?: string[]; context?: string; error?: string };
  /** Pure summarization can resume at this boundary; action executions are never blindly replayed. */
  compaction?: { offset: number; text: string };
}
export const activeBatch = (batch?: Batch | null) => !!batch && ["queued", "running", "compacting"].includes(batch.phase);
