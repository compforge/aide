import { commitStatus } from "../status.ts";
import type { AgentCall } from "../observation/reference.ts";
import type { PluginContext, Resource, ResourceCommit } from "@compforge/aide-plugin";
import { TOPIC_TYPE, initialTopicName, type TopicSpec, type TopicStatus } from "../topic/model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { resourceRef } from "../input/state.ts";
import type { Destination } from "./model.ts";
import { topicPath } from "../topic/tree.ts";
export type RoutingContext = Pick<PluginContext, "resources"> & { logger: Pick<PluginContext["logger"], "info"> };
export type RoutingInput = Readonly<Resource<InputSpec, InputStatus>>;
export const routed = (input: RoutingInput) => !!input.status.route?.completedAt;
/** @spec A routing decision and the global assessment are one atomic fact. Repeated decisions never reopen a consumer. */
export async function deliver(context: RoutingContext, original: RoutingInput, destinations: Destination[], reason: string, completedBy?: AgentCall, rootsOnly = false) {
  for (let n = 0; ; n++) {
    const input = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, ...original.metadata });
    if (!input) throw new Error("Input no longer exists");
    if (routed(input)) return;
    if (destinations.length !== 1) throw new Error("Route needs exactly one Topic destination");
    const topics = await Promise.all([...new Map(destinations.map(d => [d.uid, d])).values()].map(async d => {
      const c = await context.resources.get<TopicSpec, TopicStatus>({ ...TOPIC_TYPE, namespace: "v1", ...d });
      if (!c || c.metadata.deletionTimestamp || (rootsOnly && c.spec.parentRef)) throw new Error(`Topic no longer exists: ${d.uid}`);
      return c;
    }));
    const at = new Date().toISOString();
    const assess = input.status.assess ?? {};
    const all = await context.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
    const paths = topics.map(t => topicPath(all, t));
    const touched = [...new Map(paths.flat().map(t => [t.metadata.uid, t])).values()];
    try {
      await commitStatus(context.resources, [
        ...touched.map(c => ({ operation: "replace", resource: c, spec: { ...c.spec, name: c.spec.name || initialTopicName(input.spec.text) },
          status: { ...c.status, lastInputAt: at } }) as ResourceCommit),
        { operation: "patchStatus", resource: input, patch: { topic: resourceRef(topics[0]!), assess, route: { ...input.status.route, ...(completedBy ? { completedBy } : {}), completedAt: at,
          result: { topics: topics.map(resourceRef), reason } } } },
      ]);
      context.logger.info("Input routed", { attributes: { inputId: input.metadata.name, topicUids: topics.map(c => c.metadata.uid), reason } });
      return;
    } catch (e) { if (n >= 8 || !/version conflict/.test(String(e))) throw e; }
  }
}
