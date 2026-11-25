import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResourceClient } from "@compforge/aide-plugin";
import type { Logger } from "pino";
import { reportWork } from "../report.ts";
import type { WorkResource } from "../resources.ts";

const define = <T extends TSchema>(definition: ToolDefinition<T>) => definition;

export function reportWorkTool(resources: ResourceClient, current: () => WorkResource, log: Logger) {
  return define({ name: "report_work", label: "Report work", description: "Atomically update Work progress and acknowledge only inputs actually handled. State the result, evidence and any remaining question. Use the summary and Note tools for lasting knowledge. Use say separately for user-visible communication.",
    parameters: Type.Object({ observedGeneration: Type.Optional(Type.Integer({ minimum: 1, description: "metadata.generation from the current resource. Read and verify the updated goal if it changed during execution." })), inputIds: Type.Array(Type.String()), report: Type.String({ minLength: 1, maxLength: 16000, description: "Brief result and evidence for this handling attempt, not long-lived understanding." }),
      action: Type.Union([Type.Literal("done"), Type.Literal("wait"), Type.Literal("ask")]), question: Type.Optional(Type.String()), nextAt: Type.Optional(Type.String()) }),
    async execute(callId, args) {
      const work = current();
      const report = await reportWork(resources, work, work.status.execution!.id, args, callId);
      log.info({ workId: work.metadata.name, workKind: work.kind, executionId: work.status.execution!.id,
        inputIds: report.inputIds, status: report.status }, "Work progress reported");
      return { content: [{ type: "text" as const, text: JSON.stringify(report) }], details: {} };
    } });
}
