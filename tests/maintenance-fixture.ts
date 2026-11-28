import { noteCandidate } from "../plugins/personal/secretary/note.ts";
import { ongoingCandidate } from "../plugins/personal/secretary/ongoing.ts";
import { organizationCandidate } from "../plugins/personal/secretary/maintenance.ts";
import { summaryCandidate } from "../plugins/personal/secretary/summary.ts";
import type { InternalCandidate } from "../plugins/personal/secretary/candidate.ts";

async function dispatch(result?: { candidate?: InternalCandidate; requeueAfterMs: number }) {
  if (!result) return;
  const { candidate, requeueAfterMs } = result;
  return candidate ? { requeueAfterMs, input: await candidate.dispatch() } : { requeueAfterMs };
}
export async function prepareNoteMaintenance(...args: Parameters<typeof noteCandidate>) { return dispatch(await noteCandidate(...args)); }
export async function prepareOngoingCheck(...args: Parameters<typeof ongoingCandidate>) { return dispatch(await ongoingCandidate(...args)); }
export async function ensureOrganizationInput(...args: Parameters<typeof organizationCandidate>) { return (await organizationCandidate(...args))?.dispatch(); }
export async function checkSummary(...args: Parameters<typeof summaryCandidate>) {
  const result = await summaryCandidate(...args);
  await result.candidate?.dispatch();
  return result;
}
