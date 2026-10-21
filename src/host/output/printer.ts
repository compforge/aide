import type { OutputSpec, OutputStatus, ResourcePrinter } from "@compforge/aide-plugin";
export const outputPrinter: ResourcePrinter<OutputSpec, OutputStatus> = {
  describe: ({ metadata, spec, status }) => `Output: ${metadata.name}\nCreated: ${metadata.creationTimestamp}\nTarget: ${JSON.stringify(spec.target)}\nReceiver Persons: ${JSON.stringify(spec.receivers ?? [])}\nDelivery: ${status.phase}\nConversation: ${spec.conversation.uid}\nInputs: ${(spec.inputIds ?? []).join(", ")}\n\n${spec.text}`,
  summarize: ({ spec }) => Array.from(spec.text.replace(/\s+/gu, " ").trim()).slice(0, 120).join(""),
};
