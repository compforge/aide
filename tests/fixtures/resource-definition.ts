import { z } from "zod";
import type { ResourceDefinition, ResourceType } from "@compforge/aide-plugin";

/** Schemaless test resources still explicitly declare ownership and scope. */
export const definition = (type: ResourceType, scope: "shared" | "session" = "session"): ResourceDefinition => ({
  type, scope, schema: { spec: z.record(z.string(), z.unknown()), status: z.record(z.string(), z.unknown()) },
});
