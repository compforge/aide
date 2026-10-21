import type { ResourceDefinition } from "@compforge/aide-plugin";
export const TYPE = { apiVersion: "tests.aide.dev/v1alpha1", kind: "Printable" };
const object = { parse(value: unknown) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object"); return value; } };
const definitions: ResourceDefinition[] = [{ type: TYPE, scope: "session", schema: { spec: object, status: object },
  printer: {
    describe(resource) {
      if (resource.spec.value === "throw") throw new Error("Printer could not describe this value");
      if (resource.spec.value === "invalid") return 42 as unknown as string;
      if (resource.spec.value === "async") return Promise.resolve("late") as unknown as string;
      resource.spec.value = `${resource.spec.value}`;
      return JSON.stringify({ pid: process.pid, name: resource.metadata.name, value: resource.spec.value, phase: resource.status.phase });
    },
    summarize(resource) { return `summary: ${resource.spec.value}`; },
  },
}];
export default definitions;
