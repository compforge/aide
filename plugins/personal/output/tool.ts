import type { Persons } from "../person/service.ts";
import { contextPage } from "../background.ts";
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
    description: "Speak as Aide, never as Me. Choose who, where and what: to={me:true} contacts Me; to={personId,uid} with channelId contacts a known Person privately through that configured Channel; target specifies an explicit group or other address. Contacting others requires an existing mandate; observing messages or knowing an address grants no authority. respondToInputId replies to an assigned Channel Input and cannot be combined with to/channelId/target; Source observations are not reply paths. Without explicit routing, an unambiguous immediate Channel Input supplies the reply, otherwise contact Me via the default Channel. Use list_contacts to discover recipient IDs and configured channelId values. Never invent identities or endpoints. Include notes=[{uid,version}] for all used Notes, including summary Notes, and inputIds for Input provenance. When an external answer uses a new Input fact, first maintain a Note containing that fact and its classification, then cite it; private communication to Me does not require creating a Note. Submit the intended answer; the Output controller checks disclosure and either sends it or privately informs Me why it was withheld. Never omit references to bypass this check. Acceptance returns outputId, not delivery. Host owns retries; do not poll or recreate pending outputs. Final text is internal.",
    parameters: Type.Object({ text, notes: Type.Optional(Type.Array(Type.Object({ uid: text, version: text }), { maxItems: 100 })), inputIds: Type.Optional(Type.Array(text, { maxItems: 1001 })),
      respondToInputId: Type.Optional(text),
      to: Type.Optional(Type.Union([Type.Object({ me: Type.Literal(true) }), Type.Object({ personId: text, uid: text })])),
      channelId: Type.Optional(text),
      target: Type.Optional(Type.Union([Type.Object({ kind: Type.Literal("channel"), channelId: text, endpoint: text }),
        Type.Object({ kind: Type.Literal("requirement"), source: text, category: text, id: text, scope: text })])),
      receivers: Type.Optional(Type.Array(Type.Object({ apiVersion: text, kind: Type.Literal("Person"), namespace: text, name: text, uid: text }), { maxItems: 100 })) }),
    async execute(id, args, signal) {
      signal?.throwIfAborted();
      return { content: [{ type: "text", text: JSON.stringify(await send(id, SayInputSchema.parse(args))) }], details: {} };
    },
  };
}

export interface ContactChannel { id: string; provider: string; scope?: string; default: boolean }
/** Contact discovery exposes scoped identities and configured Channel names, never credentials or sending authority. */
export function contactsTool(persons: Persons, channels: readonly ContactChannel[], active: () => unknown): ToolDefinition {
  return {
    name: "list_contacts", label: "List contacts",
    description: "Find known recipients and sending Channels for say. Names can repeat: use personId plus uid. channelId selects private contact; target selects an explicit group/address. This directory grants no authority to contact anyone.",
    parameters: Type.Object({ query: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    async execute(_id, { query, offset = 0 }) {
      active();
      const people = (await persons.list()).filter(p => !query || p.spec.name.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => a.metadata.uid.localeCompare(b.metadata.uid))
        .map(p => ({ personId: p.metadata.name, uid: p.metadata.uid, name: p.spec.name, isMe: p.isMe,
          channels: channels.filter(c => c.provider === "local" ? p.isMe : p.spec.identities.some(i => i.provider === c.provider && i.scope === c.scope)).map(c => c.id) }));
      return { content: [{ type: "text", text: JSON.stringify({ channels, ...contextPage(people, offset) }) }], details: {} };
    },
  };
}
