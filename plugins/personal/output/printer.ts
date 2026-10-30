import type { ResourcePrinter } from "@compforge/aide-plugin";
import type { OutputSpec, OutputStatus } from "./model.ts";
export const outputPrinter: ResourcePrinter<OutputSpec, OutputStatus> = {
  describe: ({ metadata, spec, status }) => `Output: ${metadata.name}\nCreated: ${metadata.creationTimestamp}\nTarget: ${JSON.stringify(spec.target)}\nReceiver Persons: ${JSON.stringify(spec.receivers ?? [])}\nDisclosure: ${JSON.stringify(status.disclosure ?? { decision: "pending" })}\nActual delivery: ${JSON.stringify(status.delivery)}\nDelivery: ${status.phase}\nTopic: ${spec.topic.uid}\nInputs: ${(spec.inputIds ?? []).join(", ")}\n\n${spec.text}`,
  summarize: ({ spec }) => Array.from(spec.text.replace(/\s+/gu, " ").trim()).slice(0, 120).join(""),
};
