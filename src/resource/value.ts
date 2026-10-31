import { KeyedSet } from "@compforge/ts-stdx/collections";
import { isDeepStrictEqual } from "node:util";
import type { Resource, ResourceDefinition } from "@compforge/aide-plugin";

/** @spec Resource values are JSON data plus KeyedSet. JSON stores members; schemas restore identity.
 * @link docs/plugin/resource.md
 * @case tests/resource-values.test.ts
 */
export function resourceJSON(value: unknown): unknown {
  if (value instanceof KeyedSet) return Array.from(value, resourceJSON);
  if (Array.isArray(value)) return value.map(resourceJSON);
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return Object.fromEntries(Reflect.ownKeys(value).filter(key => Object.prototype.propertyIsEnumerable.call(value, key)).map(key => [key, resourceJSON(Reflect.get(value, key))]));
  return value;
}

export function cloneResourceValue<T>(value: T): T {
  if (value instanceof KeyedSet) return value.clone(cloneResourceValue) as T;
  if (Array.isArray(value)) return value.map(cloneResourceValue) as T;
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneResourceValue(child)])) as T;
  return structuredClone(value);
}

export function freezeResourceValue<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  if (value instanceof KeyedSet) {
    for (const member of value) freezeResourceValue(member);
    value.freeze();
  } else {
    for (const child of Object.values(value)) freezeResourceValue(child);
    Object.freeze(value);
  }
  return value;
}

/** Compare the declared data representation, never private class slots. */
export const equalResourceValue = (left: unknown, right: unknown): boolean => isDeepStrictEqual(resourceJSON(left), resourceJSON(right));

/** Restore Resources nested in pages, watch changes and invocation arguments after JSON IPC. */
export function decodeResources<T>(value: T, definitions: readonly ResourceDefinition[]): T {
  if (Array.isArray(value)) return value.map(child => decodeResources(child, definitions)) as T;
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return value;
  const candidate = value as unknown as Resource<unknown, unknown>;
  if (candidate.metadata?.uid && "spec" in candidate && "status" in candidate) {
    const definition = definitions.find(d => d.type.apiVersion === candidate.apiVersion && d.type.kind === candidate.kind);
    if (definition) return freezeResourceValue({ ...candidate,
      spec: definition.schema.spec.parse(candidate.spec), status: definition.schema.status.parse(candidate.status) }) as T;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeResources(child, definitions)])) as T;
}
