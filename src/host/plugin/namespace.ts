import type { ResourceNamespace } from "@compforge/aide-plugin";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** @spec Namespace segments are opaque plugin partitions, never Project or Session owners. */
export function parseResourceNamespace(value: unknown): ResourceNamespace {
  if (typeof value !== "string") throw new Error("Resource namespace must be a string");
  const parts = value.split("/");
  if (parts[0] !== "v1" || parts.some(part => !SEGMENT.test(part) || part === "." || part === "..")) {
    throw new Error("Resource namespace must be canonical v1 or v1/<stable segments>");
  }
  return value as ResourceNamespace;
}

export function namespaceContains(owner: ResourceNamespace, candidate: ResourceNamespace): boolean {
  return candidate === owner || candidate.startsWith(`${owner}/`);
}
