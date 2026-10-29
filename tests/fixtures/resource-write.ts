import jsonPatch from "fast-json-patch";
import mergePatch from "json-merge-patch";
import type { ResourceCommit } from "@compforge/aide-plugin";
/** Inspect the state a write proposes when injecting a race before its transaction. */
export function committedStatus(write: ResourceCommit): Record<string, any> | undefined {
  if (write.operation === "patchStatus") return mergePatch.apply(structuredClone(write.resource.status), write.patch);
  if (write.operation === "patch") return (write.patch.type === "json"
    ? jsonPatch.applyPatch(structuredClone(write.resource), write.patch.value as jsonPatch.Operation[]).newDocument
    : mergePatch.apply(structuredClone(write.resource), write.patch.value)).status as Record<string, any>;
  if (write.operation === "replace" || write.operation === "create") return write.status as Record<string, any>;
}
