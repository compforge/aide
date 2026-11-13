import { ResourceGarbageCollector } from "../../src/host/resource/gc.ts";
import type { ResourceStorage } from "../../src/host/resource/storage.ts";

/** Store-only fixtures have no Controllers; exercise the unmanaged deletion lifecycle. */
export async function collectResources(storage: ResourceStorage): Promise<void> {
  const gc = new ResourceGarbageCollector(storage, { lifecycle: () => "unmanaged" });
  try { await gc.run(); } finally { await gc.close(); }
}
