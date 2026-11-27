import { isResourceVersionConflict, type PluginContext } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { noteRoot } from "../note/reconcile.ts";
import { NOTE_TYPE, type NoteResource } from "../note/model.ts";
import { commitStatus } from "../status.ts";
import type { TopicPolicy } from "../topic/config.ts";
import type { TopicResource } from "../topic/model.ts";
import { prepareNoteMaintenance } from "./note.ts";

/** @spec Reserve at most one last batch for each period of external activity. A pending delivery owns its retry.
 * @link docs/personal/secretary.md#领域静默
 */
export async function settleDomain(context: PluginContext, topic: TopicResource, policy: TopicPolicy, since: string) {
  if (topic.status.execution) return;
  const queued = (await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
    matchIndex: { name: "internalPending", value: JSON.stringify([topic.metadata.uid, "aide:curate"]) }, limit: 1 })).items[0];
  if (queued && Array.isArray(queued.spec.observation?.notes)) {
    if (topic.status.closeoutFor !== since) await commitStatus(context.resources, [{ operation: "patchStatus", resource: topic, patch: { closeoutFor: since } }]);
    return;
  }
  if (topic.status.closeoutFor !== since) {
    const note = (await context.resources.page<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, {
      matchIndex: { name: "pendingCuration", value: topic.metadata.uid }, direction: "asc", limit: 1 })).items[0];
    if (note && (!note.status.curateAt || Date.parse(note.status.curateAt) <= Date.now())
        && (await noteRoot(context, note))?.metadata.uid === topic.metadata.uid) {
      if (queued) {
        // Free the single curate slot for the outstanding material before the tree sleeps.
        await commitStatus(context.resources, [{ operation: "patchStatus", resource: queued, patch: { assess: { ...queued.status.assess,
          completedAt: new Date().toISOString(), result: { disposition: "cancelled", summary: "Superseded by final Note curation" } } } },
          { operation: "patchStatus", resource: topic, patch: {} }]);
      }
      const prepared = await prepareNoteMaintenance(context, note, policy, Date.now(), true);
      if (prepared) return;
    }
  }
  try {
    await commitStatus(context.resources, [{ operation: "patchStatus", resource: topic, patch: { phase: "dormant", compactOnWake: undefined } }]);
    context.logger.info("Chief entered dormancy", { attributes: { topicUid: topic.metadata.uid, lastExternalActivity: since } });
  } catch (error) {
    if (!isResourceVersionConflict(error) && !String(error).includes("Chief has queued business")) throw error;
  }
}
