import { INPUT_TYPE, type InputSpec, type ResourcePrinter } from "@compforge/aide-plugin";

/**
 * @spec Render the original Input facts without fetching context or interpreting provider-specific observations.
 * @spec Summaries are bounded single-line previews; descriptions preserve the complete text and any supplied evidence.
 * @link docs/plugin/README.md
 * @case tests/input-printer.test.ts
 */
export const inputPrinter: ResourcePrinter<InputSpec> = {
  resourceType: INPUT_TYPE,
  describe({ metadata, spec }) {
    const lines = [
      `Input: ${metadata.name}`,
      `Origin: ${spec.origin}/${spec.originId}`,
      `Received: ${metadata.creationTimestamp}`,
    ];
    if (spec.sessionId !== undefined) lines.push(`Session: ${spec.sessionId}`);
    if (spec.timezone !== undefined) lines.push(`Timezone: ${spec.timezone}`);
    if (spec.replyTo !== undefined) lines.push(`Reply to: ${spec.replyTo}`);
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
