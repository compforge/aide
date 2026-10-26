import { ForgeWatchSchema } from "./source/forge/config.ts";
import { WeavePolicySchema } from "./weave/config.ts";
import { RoutinePolicySchema } from "./routine/config.ts";
import { TaskPolicySchema } from "./task/config.ts";
import { RoutePolicySchema } from "./route/config.ts";
import { TopicPolicySchema } from "./topic/config.ts";
import { z } from "zod";
import { EnvironmentWatchSchema } from "./source/environment/config.ts";
import { MessageWatchSchema } from "./source/message/config.ts";
import { WatchSchema } from "./source/requirement/config.ts";

/**
 * @spec Sources own observation policy. A missing Source is disabled even when its Connector is available.
 * @why Validate the namespace and policies at startup so misplaced keys cannot silently disable observation.
 * @link docs/configuration.md
 * @case tests/personal-config.test.ts
 */
export const PersonalConfigSchema = z.object({
  topic: TopicPolicySchema.optional(),
  task: TaskPolicySchema.optional(),
  routine: RoutinePolicySchema.optional(),
  route: RoutePolicySchema.optional(),
  weave: WeavePolicySchema.optional(),
  sources: z.object({
    environments: EnvironmentWatchSchema.optional(),
    lark: MessageWatchSchema.optional(),
    requirements: z.array(WatchSchema).default([]),
    forges: z.array(ForgeWatchSchema).default([]),
  }).strict().prefault({}),
}).strict();

export function parsePersonalConfig(config: Readonly<Record<string, unknown>> = {}) {
  const parsed = PersonalConfigSchema.safeParse(config);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `plugins.personal.${issue.path.join(".")} (${issue.code}: ${issue.message})`).join(", ");
    throw new Error(`Invalid Personal config: ${fields}`);
  }
  return parsed.data;
}
