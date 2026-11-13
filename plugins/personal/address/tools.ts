import { INPUT_ORIGINS, type ChiefToolDefinition } from "../../../agents/chief/input-tools.ts";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { Addresses } from "./service.ts";
import { ADDRESS_TYPE, AddressRefSchema } from "./model.ts";
import { writeSummary } from "../note/summary.ts";
import { WriterResourceSchema } from "../note/model.ts";
import { resourceRef } from "../input/state.ts";
import type { Resource } from "@compforge/aide-plugin";
import { disclosureFields, summaryDescription } from "../../../agents/context-tools.ts";
import { PersonRefsSchema } from "../person/model.ts";
import { SensitivitySchema, VisibilitySchema } from "../disclosure.ts";
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
  { name: "read_address", label: "Read address", description: "Read a communication place, its mute setting, known participants, summary Note and recent matters. Use this context to choose where and how to respond. delivery.configured reports the Host route configuration, not external delivery success or authorization. It grants no new authority.", parameters: Type.Object({ address: ref }),
    async execute(_id, args) { active(); const ref = z.object({ address: AddressRefSchema }).parse(args).address; return result({ ...addresses.view(ref), ...(delivery ? { delivery: delivery(ref) } : {}) }); } },
  ];
}
export function addressTools(addresses: Addresses, active: Active, delivery?: DeliveryCapability): ChiefToolDefinition[] {
  return [...addressReadTools(addresses, active, delivery).map(tool => ({ ...tool, inputOrigins: INPUT_ORIGINS })),
  { name: "summarize_address", inputOrigins: ["aide:review"], label: "Understand address", description: `${summaryDescription} Describe this place's purpose, roles and communication conventions. Preserve uncertainty. Cannot change muted or grant authority. Associate recent matter Notes with addresses through upsert_note.`,
    parameters: Type.Object({ address: ref, version: Type.String(), text: Type.Optional(Type.String({ maxLength: 16000 })), ...disclosureFields,
      people: Type.Optional(Type.Array(Type.Object({ apiVersion: Type.String(), kind: Type.Literal("Person"), namespace: Type.Literal("v1"), name: Type.String(), uid: Type.String() }))) }),
    async execute(_id, args) {
      const actor = active();
      const input = z.object({ address: AddressRefSchema, version: z.string(), text: z.string().max(16000).optional(), people: PersonRefsSchema().optional(), sensitivity: SensitivitySchema.optional(), visibility: VisibilitySchema.optional() }).parse(args);
      const { address, version, ...update } = input;
      await writeSummary(addresses.client, addresses.read(address), update,
        { resource: WriterResourceSchema.parse(resourceRef(actor)), executionId: actor.status.execution!.id }, version);
      return result(addresses.view(address));
    } }];
}
