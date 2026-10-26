import { iconFor } from "@compforge/aide-plugin";
import type { SourceDefinition } from "./input.ts";

/** @spec Input.originId references these definitions; presentation never changes routing or observation policy. */
export const SOURCES = {
  forges: { id: "personal.forges", label: "代码变更", icon: iconFor("source:personal.forges") },
  events: { id: "personal.events", label: "工作事件", icon: iconFor("source:personal.events") },
  environments: { id: "personal.environments", label: "环境", icon: iconFor("source:personal.environments") },
  lark: { id: "personal.lark", label: "Lark 消息", icon: iconFor("source:personal.lark") },
  requirements: { id: "personal.requirements", label: "需求", icon: iconFor("source:personal.requirements") },
} as const satisfies Record<string, SourceDefinition>;
