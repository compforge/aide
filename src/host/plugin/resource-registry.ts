import type { ResourceType } from "@compforge/aide-plugin";

import { resourceTypeKey } from "./resource.ts";

interface AideRegistration {
  readonly owner: "aide";
}

interface PluginRegistration {
  readonly owner: "plugin";
  readonly pluginId: string;
  references: number;
  materialized: boolean;
}

type ResourceTypeRegistration = AideRegistration | PluginRegistration;

/**
 * Resource GVK registration is first-register-wins; a later Plugin registration
 * never replaces Core or another Plugin.
 */
export class ResourceRegistry {
  private readonly registrations = new Map<string, ResourceTypeRegistration>();

  constructor(aideTypes: readonly ResourceType[]) {
    for (const type of aideTypes) this.registerAide(type);
  }

  isAide(type: ResourceType): boolean {
    return this.registrations.get(resourceTypeKey(type))?.owner === "aide";
  }

  register(pluginId: string, type: ResourceType): () => void {
    const registration = this.pluginRegistration(pluginId, type);
    registration.references += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.registrations.get(resourceTypeKey(type));
      if (
        current?.owner !== "plugin" ||
        current.pluginId !== pluginId
      ) {
        return;
      }
      current.references -= 1;
      if (current.references === 0 && !current.materialized) {
        this.registrations.delete(resourceTypeKey(type));
      }
    };
  }

  registerMaterialized(pluginId: string, type: ResourceType): void {
    this.pluginRegistration(pluginId, type).materialized = true;
  }

  private registerAide(type: ResourceType): void {
    const key = resourceTypeKey(type);
    if (this.registrations.has(key)) {
      throw new Error(`Resource type is already registered: ${key}`);
    }
    this.registrations.set(key, { owner: "aide" });
  }

  private pluginRegistration(
    pluginId: string,
    type: ResourceType,
  ): PluginRegistration {
    const key = resourceTypeKey(type);
    const current = this.registrations.get(key);
    if (current?.owner === "aide") {
      throw new Error(`Resource type is already registered by Aide: ${key}`);
    }
    if (current?.owner === "plugin" && current.pluginId !== pluginId) {
      throw new Error(
        `Resource type ${key} is already registered by ${current.pluginId}`,
      );
    }
    if (current?.owner === "plugin") return current;
    const registration: PluginRegistration = {
      owner: "plugin",
      pluginId,
      references: 0,
      materialized: false,
    };
    this.registrations.set(key, registration);
    return registration;
  }
}
