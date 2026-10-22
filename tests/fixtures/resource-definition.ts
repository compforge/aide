import { z } from "zod";
import type { ResourceDefinition, ResourceType } from "@compforge/aide-plugin";

/** Schemaless test resources still explicitly declare their schema. */
export const definition = (type: ResourceType): ResourceDefinition => ({
  type, schema: { spec: z.record(z.string(), z.unknown()), status: z.record(z.string(), z.unknown()) },
});
