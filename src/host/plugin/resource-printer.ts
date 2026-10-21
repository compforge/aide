import type { Resource, ResourcePrinter } from "@compforge/aide-plugin";
import { resourceTypeKey, validateResourceType } from "./resource.ts";

type PrintMethod = "describe" | "summarize";
export type HostedResourcePrinter = Pick<ResourcePrinter, "resourceType"> & {
  [Method in PrintMethod]: (resource: Readonly<Resource<unknown, unknown>>) => string | Promise<string>;
};
type PrintFailure = { pluginInstanceId: string; apiVersion: string; kind: string; name: string; method: PrintMethod };

/**
 * @spec Printer selection is scoped to Plugin Instance and exact GVK, and withdrawn with the Binding.
 * @spec Missing printers use generic text; printer errors remain visible failures, never successful fallback output.
 * @case tests/resource-printer.test.ts
 * @link docs/plugin/README.md
 */
export class ResourcePrinters {
  private readonly entries = new Map<string, HostedResourcePrinter>();
  constructor(private readonly onFailure: (detail: PrintFailure, error: unknown) => void) {}

  register(pluginInstanceId: string, printer: HostedResourcePrinter): () => void {
    validateResourceType(printer.resourceType);
    if (typeof printer.describe !== "function" || typeof printer.summarize !== "function") {
      throw new Error("Resource Printer must provide describe and summarize");
    }
    const key = this.key(pluginInstanceId, printer.resourceType);
    if (this.entries.has(key)) throw new Error(`Resource Printer already registered: ${key}`);
    this.entries.set(key, printer);
    return () => { if (this.entries.get(key) === printer) this.entries.delete(key); };
  }

  describe(pluginInstanceId: string, resource: Readonly<Resource<unknown, unknown>>): Promise<string> {
    return this.print(pluginInstanceId, resource, "describe");
  }

  summarize(pluginInstanceId: string, resource: Readonly<Resource<unknown, unknown>>): Promise<string> {
    return this.print(pluginInstanceId, resource, "summarize");
  }

  private key(pluginInstanceId: string, type: ResourcePrinter["resourceType"]): string {
    return JSON.stringify([pluginInstanceId, resourceTypeKey(type)]);
  }

  private async print(pluginInstanceId: string, resource: Readonly<Resource<unknown, unknown>>, method: PrintMethod): Promise<string> {
    const printer = this.entries.get(this.key(pluginInstanceId, resource));
    if (!printer) return method === "describe" ? JSON.stringify(resource, null, 2) : `${resource.kind}/${resource.metadata.name}`;
    try {
      // Keep in-process plugins from mutating the caller's snapshot, matching the IPC copy boundary.
      const result = await printer[method](structuredClone(resource));
      if (typeof result !== "string") throw new Error("Resource Printer result must be a string");
      return result;
    } catch (error) {
      this.onFailure({ pluginInstanceId, apiVersion: resource.apiVersion, kind: resource.kind, name: resource.metadata.name, method }, error);
      throw new Error(`Resource Printer ${method} failed for ${pluginInstanceId}: ${resource.apiVersion} ${resource.kind}/${resource.metadata.name}`, { cause: error });
    }
  }
}
