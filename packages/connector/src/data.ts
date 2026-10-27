/** Canonical JSON facts shared by local and IPC calls. Optional object fields are omitted; lossy array values are rejected. */
export function connectorData<T>(value: T): T {
  const seen = new Set<object>();
  const check = (item: unknown, path: string): void => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || item === null || seen.has(item)) throw new Error(`Connector ${path} must contain serializable facts`);
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new Error(`Connector ${path} must be plain data`);
    seen.add(item);
    for (const [name, child] of Object.entries(item)) {
      if (child === undefined && !array) continue;
      check(child, `${path}.${name}`);
    }
    seen.delete(item);
  };
  if (value === undefined) return value;
  check(value, "value");
  return JSON.parse(JSON.stringify(value)) as T;
}
