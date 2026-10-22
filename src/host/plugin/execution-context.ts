import { createHash } from "node:crypto";
import type { ExecutionScope } from "../../protocol/verbs.ts";
/** @spec A resource incarnation owns execution context. Names and input transport never identify a native session. */
export function resourceExecutionKey(scope: ExecutionScope): string {
  const resource = scope.resourceRef;
  if (!resource?.uid) throw new Error("Resource execution requires a UID-pinned resource");
  return `resource:${createHash("sha256").update(JSON.stringify([scope.pluginInstanceId, resource.apiVersion, resource.kind, resource.namespace, resource.uid, scope.controllerName ?? ""])).digest("hex")}`;
}
