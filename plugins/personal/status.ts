import jsonPatch from "fast-json-patch";
import { equalResourceValue } from "../../src/resource/value.ts";
import type { Resource, ResourceClient, ResourceCommit, ResourcePatchOperation } from "@compforge/aide-plugin";
import { setConditions, type Condition } from "./conditions.ts";
import { INPUT_TYPE, type InputStatus } from "./input/model.ts";
import { TOPIC_TYPE } from "./topic/model.ts";
import { TASK_TYPE } from "./task/model.ts";
import { ROUTINE_TYPE } from "./routine/model.ts";
import type { WorkSpecFields } from "./work/model.ts";
import type { WorkAgentStatus } from "./work/agent-status.ts";

import { inputStatus } from "./input/conditions.ts";
import { workConditions } from "./work/status.ts";

/** @spec Personal owners construct facts and their conditions before one version-checked write.
 * @why Like controller-runtime Status().Patch, storage persists the supplied observation; it does not infer business conditions.
 * @case tests/status.test.ts
 * @link docs/plugin/resource.md#conditions-契约
 */
function observed(kind: string, spec: unknown, status: unknown, generation: number, deletionTimestamp?: string): unknown {
  if (kind === "Input") return inputStatus(status as InputStatus);
  const current = status as { conditions?: Condition[]; lastError?: string | null };
  if (kind === "Topic") return { ...current, conditions: setConditions(current.conditions, [{ type: "NeedsAttention", status: current.lastError ? "True" : "False", reason: current.lastError ? "ExecutionUncertain" : "NoInterventionRequired", message: current.lastError ?? "" }]) };
  if (kind === "Task" || kind === "Routine") return { ...current, conditions: workConditions({ kind, spec, status, metadata: { generation, deletionTimestamp } } as Resource<WorkSpecFields, WorkAgentStatus>) };
  return status;
}
export function statusPatch<S, T>(resource: Readonly<Resource<S, T>>, patch: Partial<T>): Partial<T> {
  return observed(resource.kind, resource.spec, { ...resource.status, ...patch }, resource.metadata.generation, resource.metadata.deletionTimestamp) as T;
}
export function patchStatus<S, T>(resources: ResourceClient, resource: Readonly<Resource<S, T>>, patch: Partial<T>): Promise<Resource<S, T>> {
  return resources.patch(resource, { type: "json", value: jsonPatch.compare(resource.status as object, statusPatch(resource, patch) as object)
    .map(op => ({ ...op, path: `/status${op.path}` })) as ResourcePatchOperation[] }, { resourceVersion: resource.metadata.resourceVersion });
}
export function commitStatus(resources: ResourceClient, writes: readonly ResourceCommit[]) {
  return resources.commit(writes.map(write => {
    if (write.operation === "patchStatus") return { operation: "patch" as const, resource: write.resource, options: { resourceVersion: write.resource.metadata.resourceVersion },
      patch: { type: "json" as const, value: jsonPatch.compare(write.resource.status as object, statusPatch(write.resource, write.patch) as object).map(op => ({ ...op, path: `/status${op.path}` })) as ResourcePatchOperation[] } };
    if (write.operation === "replace") return { ...write, status: observed(write.resource.kind, write.spec, write.status,
      write.resource.metadata.generation + Number(!equalResourceValue(write.resource.spec, write.spec)), write.resource.metadata.deletionTimestamp) };
    if (write.operation === "create" && [INPUT_TYPE, TOPIC_TYPE, TASK_TYPE, ROUTINE_TYPE].some(type => type.apiVersion === write.type.apiVersion && type.kind === write.type.kind)) return { ...write, status: observed(write.type.kind, write.spec, write.status ?? {}, 1) };
    return write;
  }));
}
