import type { ResourceType } from "./api/index.ts";

import { resourceTypeKey } from "./resource.ts";

interface HostRegistration {
  readonly owner: "host";
}

interface PluginRegistration {
  readonly owner: "plugin";
  readonly pluginId: string;
  controllers: number;
  materialized: boolean;
}

type ResourceTypeRegistration = HostRegistration | PluginRegistration;

/**
 * Resource GVK registration is first-register-wins; a later Plugin registration
 * never replaces Core or another Plugin.
 */
export class ResourceRegistry {
  private readonly registrations = new Map<string, ResourceTypeRegistration>();

  constructor(hostTypes: readonly ResourceType[]) {
    for (const type of hostTypes) this.registerHost(type);
  }

  isHost(type: ResourceType): boolean {
    return this.registrations.get(resourceTypeKey(type))?.owner === "host";
  }

  registerController(pluginId: string, type: ResourceType): () => void {
    const registration = this.pluginRegistration(pluginId, type);
    registration.controllers += 1;
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
      current.controllers -= 1;
      if (current.controllers === 0 && !current.materialized) {
        this.registrations.delete(resourceTypeKey(type));
      }
    };
  }

  registerMaterialized(pluginId: string, type: ResourceType): void {
    this.pluginRegistration(pluginId, type).materialized = true;
  }

  private registerHost(type: ResourceType): void {
    const key = resourceTypeKey(type);
    if (this.registrations.has(key)) {
      throw new Error(`Resource type is already registered: ${key}`);
    }
    this.registrations.set(key, { owner: "host" });
  }

  private pluginRegistration(
    pluginId: string,
    type: ResourceType,
  ): PluginRegistration {
    const key = resourceTypeKey(type);
    const current = this.registrations.get(key);
    if (current?.owner === "host") {
      throw new Error(`Resource type is already registered by Host: ${key}`);
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
      controllers: 0,
      materialized: false,
    };
    this.registrations.set(key, registration);
    return registration;
  }
}
