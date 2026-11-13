import type { Resource } from "@compforge/aide-plugin";
import { z } from "zod";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { OUTPUT_TYPE, type Output } from "../output/model.ts";
import type { TopicResource } from "./model.ts";
import type { TopicStore } from "./store.ts";

const PAGE_SIZE = 10;
export interface HistorySelection { summaries?: boolean; message?: { id: string; uid: string }; liveExecutions?: ReadonlySet<string> }
export interface HistoryItem {
  id: string; uid: string; version: string; type: "input" | "message"; at: string;
  preview: string; origin?: InputSpec["origin"]; originId?: string; executionId?: string; status: string;
}
const Cursor = z.object({ topic: z.string(), at: z.string(), key: z.string() }).strict();
export function historyCursor(value: string) {
  try { return Cursor.parse(JSON.parse(Buffer.from(value, "base64url").toString())); }
  catch { throw new Error("Invalid topic history cursor"); }
}

/**
 * @spec Select a bounded page of Input/Output identities before decoding resources or reading Output streams.
 * @spec A cursor pins the Topic incarnation and a stable (created, key) boundary; newer arrivals do not shift older pages.
 * @spec Summary queries never decode historical bodies or open their streams. Only active replies keep full live content.
 * @why Observation evidence belongs to Input detail, not the repeatedly rebuilt dialogue snapshot.
 * @link docs/channel/web.md#实时进展与历史
 */
export function topicHistory(store: TopicStore, topic: TopicResource, members: readonly TopicResource[], before?: string, selection: HistorySelection = {}) {
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
    const message = selection.message;
    const messageKey = message?.id.startsWith("input:") ? store.inputStore.key(message.id.slice(6))
      : message?.id.startsWith("message:") ? store.outputStore.key(message.id.slice(8)) : "";
    const rows = storage.db.prepare(`${candidates}, selected AS MATERIALIZED (
      SELECT key, created FROM candidates ${message ? "WHERE key=?" : cursor ? "WHERE (created, key) < (?, ?)" : ""}
      ORDER BY created DESC, key DESC LIMIT ${PAGE_SIZE + 1}
    ) SELECT r.key, r.created, r.uid,
      CASE WHEN r.kind='aide.dev/Input' THEN 'input:' ELSE 'message:' END || ${field("metadata.name")} AS id,
      CASE WHEN r.kind='aide.dev/Input' THEN 'input' ELSE 'message' END AS type,
      ${field("metadata.resourceVersion")} AS version,
      substr(${field("spec.text")}, 1, 120) AS preview, ${field("spec.origin")} AS origin, ${field("spec.originId")} AS originId,
      coalesce(${field("spec.executionId")}, ${field("status.assess.completedBy.executionId")}, ${field("status.assess.executionId")}) AS executionId,
      CASE WHEN r.kind='aide.dev/Output' THEN ${field("status.phase")}
        WHEN ${field("status.assess.completedAt")} IS NOT NULL THEN 'done' ELSE 'queued' END AS status
      FROM selected c JOIN resources r ON r.key=c.key ${message ? "WHERE r.uid=?" : ""}
      ORDER BY r.created DESC, r.key DESC`)
      .all(uids, uids, topic.spec.id, topic.metadata.creationTimestamp, topic.spec.id,
        ...(message ? [messageKey, message.uid] : cursor ? [cursor.at, cursor.key] : []));
    const page = rows.slice(0, PAGE_SIZE), last = page.at(-1);
    const objects = page.filter(row => !selection.summaries || row.type === "message" && selection.liveExecutions?.has(row.executionId as string))
      .map(row => storage.read(row.key as string)!.object);
    const items: HistoryItem[] = page.map(row => ({ id: row.id as string, uid: row.uid as string, version: row.version as string,
      type: row.type as HistoryItem["type"], at: row.created as string, preview: row.preview as string ?? "",
      origin: row.origin as HistoryItem["origin"] ?? undefined, originId: row.originId as string ?? undefined,
      executionId: row.executionId as string ?? undefined, status: row.status as string }));
    const queued = cursor || message ? 0 : storage.db.prepare(`SELECT count(*) AS count FROM resource_indexes pending
      JOIN resource_ordered_indexes i ON i.source=pending.source
      WHERE pending.name='assessPending' AND pending.value IN (SELECT value FROM json_each(?))
        AND i.scope='personal' AND i.api_version='${INPUT_TYPE.apiVersion}' AND i.kind='Input' AND i.namespace='v1'
        AND i.index_name='topicActivity' AND i.index_value=pending.value`).get(uids)!.count as number;
    return { items, inputs: objects.filter(r => r.kind === "Input") as Resource<InputSpec, InputStatus>[], outputs: objects.filter(r => r.kind === "Output") as Output[], queued,
      before: rows.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({ topic: topic.metadata.uid, at: last.created, key: last.key })).toString("base64url") : null };
  });
}
