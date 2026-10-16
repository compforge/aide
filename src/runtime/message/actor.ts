import type { EventSource } from "../event/index.ts";
import type { ActorRef } from "./types.ts";

// Aide currently has one local human principal; do not leak an OS username into history.
export const HUMAN_ACTOR: ActorRef = { kind: "user", key: "local" };
export const AIDE_ACTOR: ActorRef = { kind: "aide", key: "local" };

export function actorOf(source: EventSource): ActorRef {
  switch (source.type) {
    case "user": return { ...HUMAN_ACTOR };
    case "aide": return { ...AIDE_ACTOR };
    case "harness": return { kind: "harness", key: source.harnessTargetId };
    case "plugin": return { kind: "plugin", key: source.pluginInstanceId };
    case "schedule": return { kind: "schedule", key: source.scheduleId };
  }
}
