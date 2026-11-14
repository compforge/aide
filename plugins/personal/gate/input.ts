import type { InputSpec } from "../input/model.ts";

/** @spec Only Me's one-to-one conversation with Aide enters Gate. Group mentions and Source observations stay in domains.
 * @link docs/personal/gate.md
 * @case tests/gate.test.ts
 */
export function isGateInput(input: InputSpec): boolean {
  return input.origin === "channel" && (input.originId === "web"
    || input.relation === "sent" && input.originId === "lark" && input.observation?.chatType === "p2p");
}
