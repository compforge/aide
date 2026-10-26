import { z } from "zod";
import { inputJob, inputSessions } from "../../plugins/personal/observation/job.ts";
import type { WebService } from "./service.ts";

export const ObservationQuery = z.object({ id: z.string().min(1).max(200), uid: z.string().min(1).max(250),
  format: z.enum(["json", "html"]).default("json"), download: z.enum(["1"]).optional(),
  harness: z.string().min(1).max(100).optional(), sessionId: z.string().min(1).max(250).optional(),
}).strict();
/** No caller-supplied paths: resolve only native Sessions explicitly attached to this Input incarnation. */
export async function inputObservation(aide: WebService, path: "/inputs/job" | "/inputs/session", query: z.infer<typeof ObservationQuery>) {
  const input = aide.topics.inputStore.get(query.id);
  if (!input || input.metadata.uid !== query.uid || input.metadata.deletionTimestamp) return;
  const outputs = aide.topics.outputStore.list({ inputId: query.id });
  if (path === "/inputs/job") return inputJob(input, outputs, aide.readSession?.bind(aide));
  const agent = inputSessions(input, outputs).find(a => a.harness === query.harness && a.sessionId === query.sessionId);
  if (!agent || !aide.readSession) return;
  const view = await aide.readSession(agent);
  if (view.session.id !== agent.sessionId) throw new Error("Session identity mismatch");
  return view;
}
