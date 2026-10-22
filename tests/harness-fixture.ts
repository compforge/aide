import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessStore, harnessStorageDirectory } from "../src/host/harness/store.ts";
import { newId } from "../src/host/event/ids.ts";
export type HarnessFixture = HarnessStore & { id: string; home: string };
export class HarnessFixtures {
  constructor(readonly root: string) {}
  private dir(id: string) {
    return id === "aide:execution" ? harnessStorageDirectory(this.root)
      : join(this.root, "harness-fixtures", /^[A-Za-z0-9_-]+$/.test(id) ? id : `~${createHash("sha256").update(id).digest("hex")}`);
  }
  create({ id = newId("hinv"), cwd }: { id?: string; cwd: string }): HarnessFixture {
    return Object.assign(new HarnessStore(this.dir(id), { cwd, createdAt: new Date().toISOString(), harnessTargets: {}, contexts: {} }), { id, home: this.root });
  }
  open(id: string): HarnessFixture {
    const dir = this.dir(id);
    return Object.assign(new HarnessStore(dir, JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))), { id, home: this.root });
  }
}
