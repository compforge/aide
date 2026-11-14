import type { ResourceRef } from "@compforge/aide-plugin";
import { digest } from "../chief-model.ts";
import { GATE_TOPIC_ID, TOPIC_TYPE, type TopicSpec } from "./model.ts";

export const isGateParent = (ref: ResourceRef | undefined): boolean => !!ref && ref.apiVersion === TOPIC_TYPE.apiVersion
  && ref.kind === TOPIC_TYPE.kind && ref.namespace === "v1" && ref.name === digest(GATE_TOPIC_ID);
/** @spec Gate is the global tree root; each direct child owns an independent Chief and knowledge boundary.
 * @why Parentless domain roots remain readable during startup migration and offline resource inspection.
 * @link docs/personal/gate.md
 */
export const isDomainRoot = (topic: { spec: Pick<TopicSpec, "gate" | "parentRef"> }): boolean =>
  !topic.spec.gate && (!topic.spec.parentRef || isGateParent(topic.spec.parentRef));
export const isProcessingRoot = (topic: { spec: Pick<TopicSpec, "gate" | "parentRef"> }): boolean =>
  !!topic.spec.gate || isDomainRoot(topic);
