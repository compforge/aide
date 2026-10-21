import type { ResourceType } from "@compforge/aide-plugin";

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const API_VERSION =
  /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?\/v[0-9]+(?:(?:alpha|beta)[0-9]+)?$/;
const RESOURCE_SHORT_NAME = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

export function assertPathSegment(name: string, value: string): void {
  if (!PATH_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`${name} must be a non-empty stable identifier without path separators`);
  }
}

export function validateResourceType(type: ResourceType): ResourceType {
  if (!type || typeof type !== "object") {
    throw new Error("resource type must be an object");
  }
  if (!API_VERSION.test(type.apiVersion)) {
    throw new Error(
      "resource apiVersion must use a DNS group and Kubernetes-style version",
    );
  }
  assertPathSegment("resource kind", type.kind);
  if (type.shortNames !== undefined) {
    if (
      !Array.isArray(type.shortNames) ||
      type.shortNames.length === 0 ||
      type.shortNames.some((name) => !RESOURCE_SHORT_NAME.test(name))
    ) {
      throw new Error(
        "resource shortNames must be a non-empty list of lowercase aliases",
      );
    }
  }
  return type;
}

export function resourceTypeKey(type: ResourceType): string {
  validateResourceType(type);
  return JSON.stringify([type.apiVersion, type.kind]);
}
