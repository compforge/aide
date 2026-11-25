import type { ResourceStorage } from "../../../src/host/resource/storage.ts";
import { digest } from "../identity.ts";
import { ONGOING_TYPE, OngoingSpecSchema, OngoingStatusSchema } from "./model.ts";

/** Convert stored appointments before startup validates resources. A consumed appointment stays consumed. */
export function upgradeOngoingChecks(storage: ResourceStorage): number {
  return storage.transaction(() => {
    const rows = storage.db.prepare(`SELECT key,data FROM resources WHERE scope='personal' AND kind='aide.dev/Ongoing'
      AND json_extract(data,'$.object.apiVersion')=? AND json_type(data,'$.object.status.planRevision')='integer'`).all(ONGOING_TYPE.apiVersion);
    const update = storage.db.prepare("UPDATE resources SET data=?, bytes=bytes+? WHERE key=?");
    for (const row of rows) {
      const stored = JSON.parse(String(row.data));
      const { metadata, spec, status } = stored.object;
      const { checkAt, ...intent } = spec;
      const { planRevision, followupInputId, askedFollowupId: _asked, ...state } = status;
      const current = checkAt && !state.closure && followupInputId === `followup-${digest([metadata.uid, planRevision])}`;
      stored.object.spec = OngoingSpecSchema.parse(intent);
      stored.object.status = OngoingStatusSchema.parse({ ...state, ...(checkAt ? { nextCheckAt: checkAt } : {}), ...(current ? { followupInputId } : {}) });
      metadata.resourceVersion = String(Number(metadata.resourceVersion) + 1);
      if (checkAt) metadata.generation++;
      const data = JSON.stringify(stored);
      update.run(data, Buffer.byteLength(data) - Buffer.byteLength(String(row.data)), String(row.key));
    }
    return rows.length;
  });
}
