import type { ResourcePrinter } from "@compforge/aide-plugin";
import type { InputSpec, InputStatus } from "./model.ts";

/**
 * @spec Render the original Input facts without fetching context or interpreting provider-specific observations.
 * @spec Summaries are bounded single-line previews; descriptions preserve the complete text and any supplied evidence.
 * @link docs/plugin/README.md
 * @case tests/input-printer.test.ts
 */
export const inputPrinter: ResourcePrinter<InputSpec, InputStatus> = {
  describe({ metadata, spec, status }) {
    const lines = [
      `Input: ${metadata.name}`,
      `Origin: ${spec.origin}/${spec.originId}`,
      `Received: ${metadata.creationTimestamp}`,
    ];
    if (status.topic) lines.push(`Material Topic: ${status.topic.uid}`);
    if (status.assess?.topic) lines.push(`Processing Topic: ${status.assess.topic.uid}`);
    if (spec.source) lines.push(`Source address: ${JSON.stringify(spec.source)}`);
    if (spec.topicName !== undefined) lines.push(`Suggested Topic name: ${spec.topicName}`);
    if (spec.topicKey !== undefined) lines.push(`Topic key: ${spec.topicKey}`);
    if (spec.topicId !== undefined) lines.push(`Explicit Topic: ${spec.topicId}`);
    if (spec.relation !== undefined) lines.push(`Relation to Person: ${spec.relation}`);
    if (spec.sender) lines.push(`Sender Person: ${JSON.stringify(spec.sender)}`);
    if (spec.receivers !== undefined) lines.push(`Explicit receiver Persons (not a complete audience): ${JSON.stringify(spec.receivers)}`);
    if (spec.timezone !== undefined) lines.push(`Timezone: ${spec.timezone}`);
    if (spec.originRef !== undefined) lines.push(`Source resource: ${JSON.stringify(spec.originRef)}`);
    lines.push(`\nText:\n${spec.text}`);
    if (spec.observation !== undefined) lines.push(`\nObservation:\n${JSON.stringify(spec.observation, null, 2)}`);
    return lines.join("\n");
  },
  summarize({ spec }) {
    const text = Array.from(spec.text.replace(/\s+/gu, " ").trim());
    return text.length <= 120 ? text.join("") : `${text.slice(0, 119).join("")}…`;
  },
};
