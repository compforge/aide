import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
const text = Type.String({ minLength: 1 });
const tool = <T extends TSchema>(definition: ToolDefinition<T>): ToolDefinition<T> => definition;
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
export interface RouteTools {
  route(input: { inputId: string; topicUids: string[]; reason: string }, toolCallId: string): Promise<unknown>;
  topics(offset: number, query?: string, parentUid?: string): unknown;
  input(id: string | undefined, offset: number): unknown;
}
/** @spec Route alone receives route_input. Catalog and fact reads are bounded and carry no action capability. */
export function routeTools(port: RouteTools): ToolDefinition[] {
  return [
    tool({ name: "route_input", label: "Route input", description: "Commit the complete routing decision for one admitted Input. Select one Topic UID; [] selects Default. A successful call acknowledges routing, not business processing.",
      parameters: Type.Object({ inputId: text, topicUids: Type.Array(text, { maxItems: 1 }), reason: text }),
      async execute(id, args, signal) { signal?.throwIfAborted(); return result(await port.route(args, id)); } }),
    tool({ name: "list_topics", label: "List topics", description: "Read remaining candidate summaries beyond the current topics context part. Search relevant roots or inspect one parent’s children; do not scan the whole catalog.",
      parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })), query: Type.Optional(Type.String()), parentUid: Type.Optional(Type.String()) }),
      async execute(_id, args) { return result(port.topics(args.offset ?? 0, args.query, args.parentUid)); } }),
    tool({ name: "read_input", label: "Read input", description: "Read a pending routing Input in text pages. Omit inputId to list pending IDs and delivery state. Follow nextOffset.",
      parameters: Type.Object({ inputId: Type.Optional(text), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      async execute(_id, args) { return result(port.input(args.inputId, args.offset ?? 0)); } }),
  ];
}
