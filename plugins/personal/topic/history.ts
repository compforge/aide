import type { Resource } from "@compforge/aide-plugin";
import { z } from "zod";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { OUTPUT_TYPE, type Output } from "../output/model.ts";
import type { TopicResource } from "./model.ts";
import type { TopicStore } from "./store.ts";

const PAGE_SIZE = 10;
const Cursor = z.object({ topic: z.string(), at: z.string(), key: z.string() }).strict();
export function historyCursor(value: string) {
  try { return Cursor.parse(JSON.parse(Buffer.from(value, "base64url").toString())); }
  catch { throw new Error("Invalid topic history cursor"); }
}

/**
 * @spec Select a bounded page of Input/Output identities before decoding resources or reading Output streams.
 * @spec A cursor pins the Topic incarnation and a stable (created, key) boundary; newer arrivals do not shift older pages.
 * @why Observation evidence belongs to Input detail, not the repeatedly rebuilt dialogue snapshot.
 * @link docs/channel/web.md#实时进展与历史
 */
export function topicHistory(store: TopicStore, topic: TopicResource, members: readonly TopicResource[], before?: string) {
  const storage = store.resources.storage;
  const cursor = before ? historyCursor(before) : undefined;
  if (cursor && cursor.topic !== topic.metadata.uid) throw new Error("Invalid topic history cursor");
  const uids = JSON.stringify(members.map(t => t.metadata.uid));
  const field = (path: string) => `json_extract(r.data, '$.object.${path}')`;
  return storage.transaction(() => {
    const candidates = `WITH inputs AS MATERIALIZED (
      SELECT r.key, r.created, r.uid FROM resource_ordered_indexes i INDEXED BY resource_ordered_lookup JOIN resources r ON r.key=i.source
      WHERE i.scope='personal' AND i.api_version='${INPUT_TYPE.apiVersion}' AND i.kind='Input' AND i.namespace='v1'
        AND i.index_name='topicActivity' AND i.index_value IN (SELECT value FROM json_each(?))
    ), candidates AS (
      SELECT key, created FROM inputs UNION
      SELECT r.key, r.created FROM resources r
      WHERE r.scope='personal' AND r.kind='aide.dev/Output' AND ${field("apiVersion")}='${OUTPUT_TYPE.apiVersion}'
        AND ${field("metadata.namespace")}='v1' AND ${field("metadata.deletionTimestamp")} IS NULL AND (
          ${field("spec.topic.uid")} IN (SELECT value FROM json_each(?))
          OR EXISTS (SELECT 1 FROM json_each(r.data, '$.object.spec.inputUids') ref JOIN inputs ON inputs.uid=ref.value)
          OR (${field("spec.topicId")}<>? AND r.created>=? AND ${field("status.delivery.target.kind")}='channel'
            AND ${field("status.delivery.target.channelId")}='web' AND ${field("status.delivery.target.endpoint") }=?)
        )
    )`;
    const rows = storage.db.prepare(`${candidates} SELECT key, created FROM candidates
      ${cursor ? "WHERE (created, key) < (?, ?)" : ""} ORDER BY created DESC, key DESC LIMIT ${PAGE_SIZE + 1}`)
      .all(uids, uids, topic.spec.id, topic.metadata.creationTimestamp, topic.spec.id, ...(cursor ? [cursor.at, cursor.key] : []));
    const page = rows.slice(0, PAGE_SIZE), last = page.at(-1);
    const objects = page.map(row => storage.read(row.key as string)!.object);
    const queued = cursor ? 0 : storage.db.prepare(`SELECT count(*) AS count FROM resource_indexes pending
      JOIN resource_ordered_indexes i ON i.source=pending.source
      WHERE pending.name='assessPending' AND pending.value IN (SELECT value FROM json_each(?))
        AND i.scope='personal' AND i.api_version='${INPUT_TYPE.apiVersion}' AND i.kind='Input' AND i.namespace='v1'
        AND i.index_name='topicActivity' AND i.index_value=pending.value`).get(uids)!.count as number;
    return { inputs: objects.filter(r => r.kind === "Input") as Resource<InputSpec, InputStatus>[], outputs: objects.filter(r => r.kind === "Output") as Output[], queued,
      before: rows.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({ topic: topic.metadata.uid, at: last.created, key: last.key })).toString("base64url") : null };
  });
}
