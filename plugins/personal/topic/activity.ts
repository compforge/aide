import type { InputSpec } from "../input/model.ts";
import type { TopicResource, TopicStatus } from "./model.ts";
import type { TopicPolicy } from "./config.ts";

export const externalInput = (spec: Pick<InputSpec, "origin">) =>
  spec.origin === "channel" || spec.origin === "source" || spec.origin === "aide:handoff";

/** Only external arrivals open or extend a domain's maintenance window. */
export function inWorkWindow(topic: TopicResource | undefined, policy: TopicPolicy, now = Date.now()): boolean {
  const last = topic?.status.lastInputAt;
  return !!last && now < Date.parse(last) + policy.workWindowSeconds * 1000;
}

/** @spec External arrivals wake the domain. Replaying or filing older evidence preserves the latest arrival.
 * @link docs/personal/secretary.md#工作窗口
 */
export function externalActivity(topic: TopicResource, at: string): Partial<TopicStatus> {
  const lastInputAt = topic.status.lastInputAt && topic.status.lastInputAt > at ? topic.status.lastInputAt : at;
  return { lastInputAt };
}
