import type { Resource } from "@compforge/aide-plugin";
import type { InputSpec, InputStatus } from "./model.ts";
import { inputPrinter } from "./printer.ts";

/**
 * @spec Automatic input material includes identity and text, with evidence retrieved on demand through read_input.
 * @why Full observation snapshots belong to the Input, not every Route/Chief/Work model call.
 * @link docs/personal/input.md
 */
export function inputPreview(input: Readonly<Resource<InputSpec, InputStatus>>, maxChars = 12000): string {
  const body = inputPrinter.describe({ ...input, spec: { ...input.spec, observation: undefined } });
  const evidence = input.spec.observation === undefined ? "" : "\nAdditional observation evidence is available through read_input. Read it when needed for the decision; it is not included in this preview.";
  const truncated = "\n[Text truncated; use read_input for the complete Input.]";
  const budget = Math.max(0, maxChars - evidence.length);
  return (body.length <= budget ? body : body.slice(0, Math.max(0, budget - truncated.length)) + truncated) + evidence;
}
