import { NoteDefinition } from "../note/definition.ts";
import type { Logger } from "pino";
import { ResourceStorage } from "../../../src/host/resource/storage.ts";
import { PluginResourceStore } from "../../../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../../../src/host/plugin/resource/client.ts";
import { PersonDefinition } from "./definition.ts";
import type { Me } from "./model.ts";
import { Persons } from "./service.ts";

export function openPersonCatalog(home: string, marks: Me, log: Logger, changed: () => void) {
  ResourceStorage.open(home).register("personal", [PersonDefinition, NoteDefinition]);
  const store = new PluginResourceStore({ home, pluginInstanceId: "personal" });
  const client = createResourceClient(store, (change) => {
    if (change.resource.kind !== "Person") return;
    log.info({ personId: change.resource.metadata.name, version: change.resource.metadata.resourceVersion, action: change.kind }, "Person resource changed");
    changed();
  });
  return { client, persons: new Persons(client, marks) };
}
