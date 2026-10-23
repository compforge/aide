import { join } from "node:path";
import { HarnessActivity } from "../src/host/harness/activity.ts";
import type { AnyEventEnvelope } from "../src/host/event/index.ts";
import { newId } from "../src/host/event/ids.ts";
export type HarnessFixture = HarnessActivity & { id: string; home: string; events: AnyEventEnvelope[] };
export class HarnessFixtures {
  constructor(readonly root: string) {}
  create({ id = newId("hinv"), cwd }: { id?: string; cwd: string }): HarnessFixture {
    const events: AnyEventEnvelope[] = [];
    const activity = new HarnessActivity(join(this.root, "diagnostics"), cwd);
    activity.subscribe(event => events.push(event));
    return Object.assign(activity, { id, home: this.root, events });
  }
  /** Reopens business-resource fixtures with a fresh, empty execution runtime. */
  open(id: string): HarnessFixture { return this.create({ id, cwd: this.root }); }
}
