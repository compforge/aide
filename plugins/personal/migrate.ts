import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ResourceStorage } from "../../src/host/resource/storage.ts";
/** @spec Move legacy Personal resources atomically; preserve UIDs, versions and pending work. Never replay native Sessions. */
export function migratePersonalResources(storage: ResourceStorage): number {
  let moved = 0;
  storage.transaction(() => {
    for (const row of storage.db.prepare("SELECT * FROM resources").all()) {
      const value = JSON.parse(row.data as string);
      const coreFact = row.scope === "core" && ["Input", "Output"].includes(value.object.kind);
      const [session, plugin] = coreFact ? ["legacy", "personal"] : String(row.scope).startsWith("[") ? JSON.parse(row.scope as string) : [];
      if (!session || plugin !== "personal") continue;
      const resource = value.object;
      migrateReferences(resource);
      if (coreFact) resource.metadata.namespace = "v1";
      value.control ??= {};
      if (coreFact) {
        value.owner = resource.kind === "Input" ? resource.spec.sessionId ?? "personal" : resource.spec.conversationId;
        // Receipt fingerprints include provenance. Normalize retained facts and their receipts in the same transaction.
        const fingerprint = createHash("sha256").update(JSON.stringify({ owner: value.owner, spec: resource.spec }, (_key, item) =>
          item && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
        storage.db.prepare("UPDATE receipts SET value=json_set(value,'$.fingerprint',?) WHERE key=?")
          .run(fingerprint, `${resource.kind.toLowerCase()}:${resource.metadata.name}`);
      }
      const [group, version] = resource.apiVersion.split("/");
      const key = join(storage.home, "shared", "plugins", plugin, "namespaces", encodeURIComponent(resource.metadata.namespace), "resources", group, version, resource.kind, encodeURIComponent(resource.metadata.name) + ".json");
      if (storage.db.prepare("SELECT 1 FROM resources WHERE key=?").get(key)) throw new Error(`Cannot migrate duplicate ${resource.kind}/${resource.metadata.name}`);
      delete resource.metadata.sessionId;
      if (resource.kind === "Conversation") delete resource.spec.sessionId;
      // Native bindings belonged to the old execution journal. Business history remains authoritative.
      delete resource.status.contextId;
      const refs = storage.db.prepare("SELECT target FROM resource_refs WHERE source=?").all(row.key!);
      storage.db.prepare("DELETE FROM resources WHERE key=?").run(row.key!);
      const data = JSON.stringify(value);
      storage.db.prepare("INSERT INTO resources (key,scope,kind,uid,data,bytes,created,accessed,released) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(key, JSON.stringify([null, plugin]), row.kind!, row.uid!, data, Buffer.byteLength(data), row.created!, row.accessed!, row.released!);
      for (const ref of refs) storage.db.prepare("INSERT INTO resource_refs VALUES (?,?)").run(key, ref.target!);
      moved++;
    }
  });
  return moved;
}

function migrateReferences(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (typeof object.apiVersion === "string" && typeof object.kind === "string"
      && typeof object.namespace === "string" && typeof object.name === "string") {
    delete object.sessionId;
    if (object.namespace === "aide-system" && ["Input", "Output"].includes(String(object.kind))) object.namespace = "v1";
  }
  for (const [key, child] of Object.entries(object)) {
    // Source evidence is immutable external data, even if it happens to resemble a resource reference.
    if (key !== "observation") migrateReferences(child);
  }
}
