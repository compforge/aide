import { Type, type TSchema } from "typebox";
import { INPUT_ORIGINS, type ChiefToolDefinition } from "./input-tools.ts";
import type { Persons } from "../../person/service.ts";
const tool = <T extends TSchema>(definition: ChiefToolDefinition<T>): ChiefToolDefinition<T> => definition;
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
/** @spec Chief revises understanding, preserving user corrections in summary; never changes identities or Me marks. */
export function personTools(persons: Persons): ChiefToolDefinition[] {
  return [
    tool({ name: "list_persons", inputOrigins: INPUT_ORIGINS, label: "List persons", description: "Find known people across topics. Names are not unique. Read a person before revising their summary.",
      parameters: Type.Object({}), async execute() { return result((await persons.list()).map((p) => ({ id: p.metadata.name, name: p.spec.name, isMe: p.isMe }))); } }),
    tool({ name: "read_person", inputOrigins: INPUT_ORIGINS, label: "Read person", description: "Read identities, contact Addresses (spec.addresses is an unordered UID set), their current endpoint/mute state, long-lived summary, Note directory and resource version. Use read_note for the related Note bodies. Contacts are direct ways to reach this human, not all their groups. Select one suitable Address explicitly; never fan out or use array order as priority.",
      parameters: Type.Object({ id: Type.String({ minLength: 1, description: "Person metadata.name, or id returned by list_persons. For Input/Output references use ref.name here, not ref.uid or the channel user ID." }), uid: Type.Optional(Type.String({ minLength: 1, description: "Supply ref.uid separately when reading an Input/Output Person reference to verify the exact resource." })) }),
      async execute(_id, args) {
        try { const { recent: _recent, ...person } = await persons.read(args.id, args.uid); return result({ ...person, notes: await persons.noteDirectory(person.metadata.name, person.metadata.uid) }); }
        // @spec An unmatched lookup does not prove deletion; wrong identifier kinds can produce the same result.
        catch (error) { if (!String(error).includes("Unknown Person")) throw error; return result({ found: false, id: args.id, message: "No Person matched the supplied id/uid. This does not establish deletion. Use ref.name as id and ref.uid separately, or list_persons; original message evidence remains available." }); }
      } }),
  ];
}
