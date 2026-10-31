import { cloneResourceValue } from "../../../resource/value.ts";
import type { Resource, ResourceDefinition, ResourceType } from "@compforge/aide-plugin";

type PrintMethod = "describe" | "summarize";
type PrintFailure = { pluginInstanceId: string; apiVersion: string; kind: string; name: string; method: PrintMethod };

/**
 * @spec Printers belong to resource definitions and remain available without a running Controller or Runner.
 * @spec Supplied snapshots are isolated; missing Printers use generic text, while callback failures propagate.
 * @link docs/plugin/README.md
 */
export class ResourcePrinters {
  constructor(private readonly onFailure: (detail: PrintFailure, error: unknown) => void,
    private readonly resolve: (owner: string, type: ResourceType) => ResourceDefinition | undefined) {}
  describe(owner: string, resource: Readonly<Resource<unknown, unknown>>): Promise<string> { return this.print(owner, resource, "describe"); }
  summarize(owner: string, resource: Readonly<Resource<unknown, unknown>>): Promise<string> { return this.print(owner, resource, "summarize"); }
  private async print(pluginInstanceId: string, resource: Readonly<Resource<unknown, unknown>>, method: PrintMethod): Promise<string> {
    const printer = this.resolve(pluginInstanceId, resource)?.printer;
    if (!printer) return method === "describe" ? JSON.stringify(resource, null, 2) : `${resource.kind}/${resource.metadata.name}`;
    try {
      const result = printer[method](cloneResourceValue(resource));
      if (typeof result !== "string") throw new Error("Resource Printer must synchronously return a string");
      return result;
    } catch (error) {
      this.onFailure({ pluginInstanceId, apiVersion: resource.apiVersion, kind: resource.kind, name: resource.metadata.name, method }, error);
      throw new Error(`Resource Printer ${method} failed for ${pluginInstanceId}: ${resource.apiVersion} ${resource.kind}/${resource.metadata.name}`, { cause: error });
    }
  }
}
