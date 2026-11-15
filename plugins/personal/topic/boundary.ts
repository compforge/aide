import type { ResourceRef } from "@compforge/aide-plugin";
import { digest } from "../chief-model.ts";
import { GATE_TOPIC_ID, TOPIC_TYPE, type TopicSpec } from "./model.ts";

type TopicTreeNode = { spec: Pick<TopicSpec, "parentRef"> };
export const isGateParent = (ref: ResourceRef | undefined): boolean => !!ref && ref.apiVersion === TOPIC_TYPE.apiVersion
  && ref.kind === TOPIC_TYPE.kind && ref.namespace === "v1" && ref.name === digest(GATE_TOPIC_ID);
/** @spec Gate is the unique parentless Topic; its direct children own independent Chiefs and knowledge.
 * @link docs/personal/gate.md
 */
export const isGateTopic = (topic: TopicTreeNode | undefined): boolean => !!topic && !topic.spec.parentRef;
export const isRootTopic = (topic: TopicTreeNode): boolean => isGateParent(topic.spec.parentRef);
export const isProcessingRoot = (topic: TopicTreeNode): boolean => isGateTopic(topic) || isRootTopic(topic);
