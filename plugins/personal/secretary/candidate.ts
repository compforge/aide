import { compareInputPriority, InputAttention, type InputPriority } from "../input/model.ts";
import type { PreparedIntake } from "./intake.ts";
import type { Input } from "../input/state.ts";

/** A rule can describe an eligible Input without reserving material or creating a CRD. */
export interface InternalCandidate extends InputPriority {
  dispatch(): Promise<Input | undefined>;
}

export function reviewAttention(since: string, normalIntervalMs: number, now: number) {
  return now - Date.parse(since) >= 2 * normalIntervalMs ? InputAttention.High : InputAttention.Normal;
}

export type DispatchCandidate = InternalCandidate | (InputPriority & { intake: PreparedIntake });

/** @spec Only the selected candidate may create an Input. A stale demand releases its place. */
export async function selectIntake(candidates: DispatchCandidate[]): Promise<PreparedIntake | undefined> {
  for (const candidate of candidates.sort(compareInputPriority)) {
    if ("intake" in candidate) return candidate.intake;
    const input = await candidate.dispatch();
    if (input) return { inputs: [input] };
  }
}
