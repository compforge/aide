import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { Addresses } from "./service.ts";
import { ADDRESS_TYPE, AddressRefSchema } from "./model.ts";
import type { Resource } from "@compforge/aide-plugin";
const ref = Type.Object({ apiVersion: Type.Literal(ADDRESS_TYPE.apiVersion), kind: Type.Literal("Address"), namespace: Type.Literal("v1"), name: Type.String(), uid: Type.String() });
const result = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }], details: {} });
type DeliveryCapability = (ref: import("./model.ts").AddressRef) => { configured?: boolean; reason?: string };
type Active = () => Resource<unknown, { execution?: { id: string } | null }>;
/** @spec Work can discover communication places without gaining authority to edit their shared understanding.
 * @case tests/pi-agent.test.ts
 * @link docs/personal/address.md
 */
export function addressReadTools(addresses: Addresses, active: Active, delivery?: DeliveryCapability): ToolDefinition[] {
  return [{ name: "list_addresses", label: "Find addresses", description: "Find known communication places and participants. Filter by Person UID. muted means Aide cannot speak there. Original place is preferred only when suitable for the content. Known participants are partial evidence, not a complete membership roster. Follow continue for more places.",
    parameters: Type.Object({ person: Type.Optional(Type.String()), continue: Type.Optional(Type.String()) }),
    async execute(_id, args) { active(); const query = z.object({ continue: z.string().optional(), person: z.string().optional() }).parse(args); return result(addresses.page(query.continue, query.person)); } },
  { name: "read_address", label: "Read address", description: "Read a communication place, its mute setting, known participants, summary Note and related Note directory. Use read_note for the Note bodies. Use this context to choose where and how to respond. delivery.configured reports the Host route configuration, not external delivery success or authorization. It grants no new authority.", parameters: Type.Object({ address: ref }),
    async execute(_id, args) { active(); const ref = z.object({ address: AddressRefSchema }).parse(args).address; const { recent: _recent, ...view } = addresses.view(ref); return result({ ...view, notes: addresses.noteDirectory(ref), ...(delivery ? { delivery: delivery(ref) } : {}) }); } },
  ];
}
