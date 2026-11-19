import { isRootTopic } from "../../topic/boundary.ts";
import { identityBackground } from "../../execution/agent/identity.ts";
import { topicCandidatePage } from "../../background.ts";
import { Background as RouteBackground } from "../background.ts";
import type { PiConfig } from "../../../../src/host/harness/pi/config.ts";
import { createRouteAgent } from "./agent.ts";
import { agentCall } from "../../observation/reference.ts";
import { resourceRef } from "../../input/state.ts";
import { ROUTE_TYPE, type RouteStatus } from "../model.ts";
import { deliver, routed } from "../delivery.ts";
import { defaultDestination } from "../rules.ts";
import { z } from "zod";
import type { ExecutionScope } from "../../../../src/protocol/verbs.ts";
import type { TopicSpec, TopicStatus } from "../../topic/model.ts";
import type { Logger } from "pino";
import type { Manager } from "../../../../src/host/plugin/manager.ts";
import type { Store } from "../../work/store.ts";
import { TOPIC_TYPE } from "../../topic/model.ts";
import type { PiSessionFactory } from "../../../../src/host/harness/pi/adapter.ts";
import type { Persons } from "../../person/service.ts";

import { readRouteInput } from "../../execution/agent/read-input.ts";

export function routeSession(scope: ExecutionScope, config: PiConfig, store: Store, plugins: Manager, log: Logger, persons: Persons): PiSessionFactory {
  const ref = scope.resourceRef;
  if (scope.pluginInstanceId !== "personal" || ref?.kind !== ROUTE_TYPE.kind || ref.apiVersion !== ROUTE_TYPE.apiVersion || !ref.uid) throw new Error("Route requires a Route resource scope");
  return async options => {
    const initial = store.resources.get<Record<string, never>, RouteStatus>(ROUTE_TYPE, ref.name, ref.namespace);
    if (initial.metadata.uid !== ref.uid || initial.metadata.deletionTimestamp) throw new Error("Route resource is missing or replaced");
    const active = () => {
      const route = store.resources.get<Record<string, never>, RouteStatus>(ROUTE_TYPE, ref.name, ref.namespace);
      if (route.metadata.uid !== initial.metadata.uid || !route.status.execution) throw new Error("Route execution is not active");
      plugins.executionVerbs(route.status.execution.id, {});
      return route;
    };
    return createRouteAgent({ ...options, config, scope: `route:${initial.metadata.uid}`, background: identityBackground(persons, () => { active(); return new RouteBackground(store); }), port: {
      topics: (offset, query, parentUid) => {
        active();
        const page = topicCandidatePage(store, offset, query, parentUid);
        return { topics: page.items, total: page.total, catalogFingerprint: page.catalogFingerprint, fingerprint: page.fingerprint, nextOffset: page.nextOffset };
      },
      input: (id, offset) => { const r = active(); return readRouteInput(store, resourceRef(r), id, offset); },
      route: async (raw, toolCallId) => {
        const args = z.object({ inputId: z.string(), topicUids: z.array(z.string()).max(1), reason: z.string().min(1).max(4000) }).strict().parse(raw);
        const r = active();
        const input = store.topics.inputStore.get(args.inputId);
        if (!input) throw new Error("Input is not owned by Route");
        if (routed(input)) return { routed: args.inputId };
        if (input.status.route?.executionId !== r.status.execution!.id) throw new Error("Input has not been admitted to Route");
        const resources = plugins.resourceClient("personal");
        const context = { resources, logger: { info: (message: string, detail?: unknown) => log.info({ detail }, message) } };
        const topics = await resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
        const destinations = [...new Set(args.topicUids)].map(uid => {
          const c = topics.find(c => c.metadata.uid === uid && !c.metadata.deletionTimestamp);
          if (!c || !isRootTopic(c)) throw new Error(`Root Topic no longer exists: ${uid}`);
          return { name: c.metadata.name, uid };
        });
        if (!destinations.length) destinations.push(await defaultDestination(context));
        await deliver(context, input, destinations, args.reason, agentCall(r.status, toolCallId), true);
        return { routed: args.inputId, topicUids: destinations.map(c => c.uid) };
      },
    } });
  };
}
