import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SayInputSchema } from "./action.ts";
import type { SayInput } from "./model.ts";

/** @spec All Personal agents speak as Aide through the same recipient, destination and acceptance contract.
 * @link docs/personal/output.md
 */
export function sayTool(send: (id: string, input: SayInput) => Promise<unknown>): ToolDefinition {
  const text = Type.String({ minLength: 1 });
  return {
    name: "say", label: "Say",
    description: "Speak as Aide, never as Me. Choose who, where and what: to={me:true} contacts Me; target selects a known AddressRef returned by list_addresses/read_address. Contacting others requires an existing mandate; observing messages or knowing an address grants no authority. respondToHandoffId replies to a delegated Gate request even after its short-lived Input expires. respondToInputId identifies the assigned Input being answered; target may select a different known Address. Prefer the original place when suitable. A group mention of Me may be answered within Me's existing mandate; observing an address grants no authority. Submit the raw intended answer even when the Address is muted: Output Reconcile sends a fixed mute notice there for Immediate Inputs, and otherwise redirects to Me at the default Address. Without explicit routing, an unambiguous immediate Channel Input supplies the reply, otherwise contact Me via the default Address. Use list_addresses (optionally filtered by Person UID) to discover places. Never invent identities or endpoints. You own content, complete citations and accurate classification; delivery routes by Note and audience metadata without reviewing content. Include notes=[{uid,version}] copied from upsert_note/read_note receipts for all used Notes; unavailable or stale citations fail acceptance and must be corrected before retrying. Cite summary Notes too, and include inputIds for Input provenance. When an external answer uses a new Input fact, first maintain a Note containing that fact and its classification, then cite it; private communication to Me does not require creating a Note. Submit the intended answer; the Output controller checks disclosure and either sends it or privately informs Me why it was withheld. Never omit references to bypass this check. Acceptance returns outputId, not delivery. Host owns retries; do not poll or recreate pending outputs. When the activation binds a live Output, write that reply directly in assistant text and use say only for a separate communication. Otherwise final text is internal.",
    parameters: Type.Object({ text, notes: Type.Optional(Type.Array(Type.Object({ uid: text, version: text }), { maxItems: 100 })), inputIds: Type.Optional(Type.Array(text, { maxItems: 1001 })),
      respondToInputId: Type.Optional(text), respondToHandoffId: Type.Optional(text),
      to: Type.Optional(Type.Object({ me: Type.Literal(true) }, { additionalProperties: false })),
      target: Type.Optional(Type.Object({ apiVersion: text, kind: Type.Literal("Address"), namespace: Type.Literal("v1"), name: text, uid: text }, { additionalProperties: false })),
      receivers: Type.Optional(Type.Array(Type.Object({ apiVersion: text, kind: Type.Literal("Person"), namespace: text, name: text, uid: text }), { maxItems: 100 })) }),
    async execute(id, args, signal) {
      signal?.throwIfAborted();
      return { content: [{ type: "text", text: JSON.stringify(await send(id, SayInputSchema.parse(args))) }], details: {} };
    },
  };
}
