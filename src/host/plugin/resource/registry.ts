import type { ResourceType } from "@compforge/aide-plugin";
import { resourceTypeKey } from "./type.ts";

/** Definition ownership outlives Controllers and Runner activation. */
export class ResourceRegistry {
  private readonly owners = new Map<string, string>();
  constructor(aideTypes: readonly ResourceType[]) {
    for (const type of aideTypes) this.owners.set(resourceTypeKey(type), "Aide");
  }
  isAide(type: ResourceType): boolean { return this.owners.get(resourceTypeKey(type)) === "Aide"; }
  check(pluginId: string, types: readonly ResourceType[]): void {
    for (const type of types) {
      const key = resourceTypeKey(type), owner = this.owners.get(key);
      if (owner !== undefined && (owner === "Aide" || owner !== pluginId)) throw new Error(`Resource type ${key} is already registered by ${owner}`);
    }
  }
  declare(pluginId: string, types: readonly ResourceType[]): void {
    this.check(pluginId, types);
    for (const type of types) this.owners.set(resourceTypeKey(type), pluginId);
  }
}
