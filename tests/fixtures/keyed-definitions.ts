import { KeyedSet } from "@compforge/ts-stdx/collections";
import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
export const KEYED_TYPE = { apiVersion: "tests.aide.dev/v1", kind: "Members" };
export const members = (items: Iterable<{ uid: string; label?: string }> = []) => new KeyedSet(item => item.uid, items);
export const MembersSchema = z.preprocess(value => value instanceof KeyedSet ? [...value] : value,
  z.array(z.object({ uid: z.string(), label: z.string().optional() })).transform(values => members(values.sort((a, b) => a.uid.localeCompare(b.uid)))));
export const KeyedDefinition = { type: KEYED_TYPE,
  schema: { spec: z.object({ people: MembersSchema }), status: z.object({ receivers: MembersSchema, done: z.boolean().optional() }) },
  indexes: { people: resource => [...resource.spec.people].map(p => p.uid) },
  retention: { releasedAt: () => undefined, references: resource => [...resource.status.receivers].map(p => p.uid) },
} satisfies ResourceDefinition<{ people: ReturnType<typeof members> }, { receivers: ReturnType<typeof members>; done?: boolean }>;
export default [KeyedDefinition];
