import assert from "node:assert/strict";
import { KeyedSet } from "@compforge/ts-stdx/collections";
import type { PluginPackage } from "@compforge/aide-plugin";
import { KEYED_TYPE, members } from "./keyed-definitions.ts";
type Spec = { people: ReturnType<typeof members> };
type Status = { receivers: ReturnType<typeof members>; done?: boolean };
export default { pluginId: "tests/keyed-plugin", version: "1.0.0", async activate(context) {
  let watched = false;
  context.controllers.register<Spec, Status>({ resourceType: KEYED_TYPE,
    watches: [{ resourceType: KEYED_TYPE, handler: {
      async create(event) { assert((event.object.spec as Spec).people instanceof KeyedSet); watched = true; return []; },
      async update(event) { assert((event.newObject.spec as Spec).people instanceof KeyedSet); return []; },
      async delete(event) { assert((event.object.spec as Spec).people instanceof KeyedSet); return []; },
    } }],
    async reconcile(_execution, resource) {
      if (resource.status.done) return;
      assert(watched);
      assert(resource.spec.people instanceof KeyedSet);
      assert.throws(() => resource.spec.people.clear(), TypeError);
      const current = await context.resources.get<Spec, Status>({ ...KEYED_TYPE, ...resource.metadata });
      assert(current?.spec.people.has({ uid: "a" }));
      const page = await context.resources.page<Spec, Status>(KEYED_TYPE, { limit: 2 });
      assert(page.items[0]?.status.receivers instanceof KeyedSet);
      const list = await context.resources.list<Spec, Status>(KEYED_TYPE);
      assert(list[0]?.spec.people instanceof KeyedSet);
      const copy = resource.spec.people.clone();
      copy.add({ uid: "b" });
      const updated = await context.resources.patch(resource, { type: "merge", value: { status: { receivers: copy, done: true } } });
      assert(updated.status.receivers.has({ uid: "b" }));
    },
  });
} } satisfies PluginPackage;
