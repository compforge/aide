import { workPhase } from "../status.ts";
import { isDeepStrictEqual } from "node:util";
import type { Resource, ResourceValidationContext } from "@compforge/aide-plugin";
import type { WorkAgentStatus } from "../work-status.ts";
import { requireTopic } from "./ownership.ts";
/** @spec Work has one UID-pinned current Topic. Running work finishes before ownership changes.
 * @link docs/personal/topic.md#归属调整与责任交接
 */
export function guardWork(current: Resource<import("../model.ts").WorkSpecFields, WorkAgentStatus>, context: ResourceValidationContext, previous?: Resource<import("../model.ts").WorkSpecFields, WorkAgentStatus>) {
  requireTopic(current.status.topic, context);
  if (previous && !isDeepStrictEqual(previous.status.topic, current.status.topic)
    && (previous.status.execution || current.status.execution || workPhase(previous) === "running" || workPhase(current) === "running"))
    throw new Error("Finish Work execution before moving Topic ownership");
}
