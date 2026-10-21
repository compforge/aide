import { z } from "zod";
import { EnvironmentWatchSchema } from "./source/environment/config.ts";
import { MessageWatchSchema } from "./source/message/config.ts";
import { WatchSchema } from "./source/requirement/config.ts";
import { PersonSchema } from "./person.ts";

/**
 * @spec Sources own observation policy. A missing Source is disabled even when its Connector is available.
 * @why Validate the namespace and policies at startup so misplaced keys cannot silently disable observation.
 * @link docs/configuration.md
 * @case tests/personal-config.test.ts
 */
export const PersonalConfigSchema = z.object({
  person: PersonSchema.prefault({}),
  sources: z.object({
    environments: EnvironmentWatchSchema.optional(),
    lark: MessageWatchSchema.optional(),
    requirements: z.array(WatchSchema).default([]),
  }).strict().prefault({}),
}).strict();

export function parsePersonalConfig(config: Readonly<Record<string, unknown>> = {}) {
  const parsed = PersonalConfigSchema.safeParse(config);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `plugins.personal.${issue.path.join(".")} (${issue.code})`).join(", ");
    throw new Error(`Invalid Personal config: ${fields}`);
  }
  return parsed.data;
}
