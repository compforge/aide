import type { AgentStreamView, StreamTool } from "../stream/agent.ts";
import { textOf } from "../host/event/index.ts";
import { toolLabels } from "./reply-layout.ts";
export function toolText(tool: StreamTool): string {
  const value = (data: unknown) => typeof data === "string" ? data : data == null ? "" : JSON.stringify(data, null, 2);
  return [`${tool.title ?? tool.toolCallId} · ${toolLabels[tool.status ?? ""] ?? tool.status ?? "状态未知"}`,
    value(tool.rawInput), textOf(tool.content), value(tool.rawOutput)].filter(Boolean).join("\n");
}
export function mailProcess(mail: AgentStreamView): string {
  return [mail.think, ...mail.tools.map(toolText)].filter(Boolean).join("\n\n");
}
