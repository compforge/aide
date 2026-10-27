import { isDeepStrictEqual } from "node:util";
import type { ResourceClient, ResourceType, ResourceNamespace } from "@compforge/aide-plugin";

/**
 * @spec Polling policy changes preserve the observer UID and checkpoint; callers choose a new identity for a changed observation scope.
 * @link docs/connector/forge.md
 * @case tests/repository-source.test.ts
 */
export async function configureSource<S>(resources: ResourceClient, type: ResourceType, name: string, spec: S,
  namespace: ResourceNamespace = "v1"): Promise<boolean> {
  const existing = await resources.get<S, unknown>({ ...type, namespace, name });
  if (!existing) {
    await resources.create(type, { name, namespace, spec });
    return true;
  }
  if (!isDeepStrictEqual(existing.spec, spec)) await resources.replace(existing, spec, existing.status);
  return false;
}
