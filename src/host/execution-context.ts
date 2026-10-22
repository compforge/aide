import type { HarnessResumeState } from "./harness/resume.ts";
import type { HarnessLaunchSnapshot } from "./harness/target.ts";

export interface HarnessSessionMeta {
  harness: string;
  launchSnapshot?: HarnessLaunchSnapshot;
  harnessSessionId?: string;
  resumeState?: HarnessResumeState;
  resumeCursor?: string;
  contextEpochId?: string;
  syncedSeq?: number;
  /** Deliberate context replacement excludes earlier journal entries on native reconstruction. */
  contextAfterSeq?: number;
  parentSessionId?: string;
}

/** @spec A resource/controller context owns reusable native bindings, never a business queue or a parent/child task line.
 * @link docs/kernel.md
 */
export interface ExecutionContextMeta {
  contextId: string;
  historyAfterSeq?: number;
  harnessSessions: Record<string, HarnessSessionMeta>;
}
