import type { ResourceStorage } from "../../../src/host/resource/storage.ts";
import { pageBounds, pageSize, type PageQuery } from "../browse.ts";
import { NOTE_TYPE, noteName, type NoteResource, type NoteSpec } from "../note/model.ts";
import { ONGOING_TYPE, ongoingView, type OngoingResource } from "../ongoing/model.ts";
import { ROUTINE_TYPE } from "../routine/model.ts";
import { TASK_TYPE } from "../task/model.ts";
import { TOPIC_TYPE } from "../topic/model.ts";
import type { WorkResource } from "../work/resources.ts";
import { workDueAt, workPhase } from "../work/status.ts";

const field = (alias: string, path: string) => `json_extract(${alias}.data, '$.object.${path}')`;
const live = `r.scope = 'personal' AND ${field("r", "metadata.namespace")} = 'v1' AND ${field("r", "metadata.deletionTimestamp")} IS NULL`;
const topicJoin = (uid: string) => `LEFT JOIN resources t ON t.uid = ${uid} AND t.scope = r.scope
  AND t.kind = 'aide.dev/Topic' AND ${field("t", "apiVersion")} = '${TOPIC_TYPE.apiVersion}' AND ${field("t", "metadata.deletionTimestamp")} IS NULL`;
const topicColumns = `${field("t", "spec.id")} AS topicId, ${field("t", "spec.name")} AS topicName`;

function selectPage<T>(storage: ResourceStorage, query: PageQuery, where: string, args: string[],
  order: string, joins: string, columns: string, project: (row: Record<string, unknown>) => T) {
  const size = pageSize(query);
  return storage.transaction(() => {
    const matches = `FROM resources r WHERE ${live} AND ${where}`;
    const total = Number(storage.db.prepare(`SELECT count(*) AS n ${matches}`).get(...args)!.n);
    const bounds = pageBounds(total, size, query.page);
    const rows = storage.db.prepare(`WITH page AS MATERIALIZED (
      SELECT r.key ${matches} ORDER BY ${order}, r.uid LIMIT ? OFFSET ?)
      SELECT r.data, ${columns} FROM page JOIN resources r ON r.key = page.key ${joins} ORDER BY ${order}, r.uid`)
      .all(...args, size, (bounds.page - 1) * size);
    return { ...bounds, items: rows.map(project) };
  });
}

export interface GateNoteQuery extends PageQuery { nature?: NoteSpec["nature"] | "unclassified" }

/** @spec Summary identity and nature are independent. An unclassified Note remains discoverable.
 * @link docs/channel/web.md
 */
export function browseGateNotes(storage: ResourceStorage, query: GateNoteQuery) {
  const args: string[] = [NOTE_TYPE.apiVersion];
  let where = `r.kind = 'aide.dev/Note' AND ${field("r", "apiVersion")} = ? AND ${field("r", "status.retired")} IS NULL`;
  if (query.nature === "unclassified") where += ` AND ${field("r", "spec.nature")} IS NULL`;
  else if (query.nature) { where += ` AND ${field("r", "spec.nature")} = ?`; args.push(query.nature); }
  const joins = `LEFT JOIN resources s ON s.uid = ${field("r", "spec.subject.uid")} AND s.scope = r.scope
    AND ${field("s", "metadata.deletionTimestamp")} IS NULL
    ${topicJoin(`CASE WHEN s.kind = 'aide.dev/Topic' THEN s.uid ELSE ${field("s", "status.topic.uid")} END`)}`;
  return selectPage(storage, query, where, args, `${field("r", "status.updatedAt")} DESC`, joins,
    `s.uid AS ownerUid, coalesce(${field("s", "spec.name")}, ${field("s", "spec.title")}, ${field("s", "spec.id")}) AS ownerName, ${topicColumns}`, row => {
      const note = storage.decode("personal", row.data as string).object as NoteResource;
      return { uid: note.metadata.uid, title: noteName(note.spec), updatedAt: note.status.updatedAt, nature: note.spec.nature,
        subject: note.spec.subject, summaryKind: note.spec.summaryOf?.kind, ownerAvailable: !!row.ownerUid,
        ownerName: String(row.ownerName ?? note.spec.subject.name), topicId: row.topicId as string | null };
    });
}

const workTypes = { ongoing: ONGOING_TYPE, task: TASK_TYPE, routine: ROUTINE_TYPE };
export interface GateWorkQuery extends PageQuery { kind?: keyof typeof workTypes; state?: "active" | "ended" | "all" }

/** @spec Page the combined Work population. Its existing openTopic and maintenance indexes identify active work,
 * including paused Routines and Tasks reopened for a new generation.
 * @link docs/channel/web.md
 */
export function browseGateWork(storage: ResourceStorage, query: GateWorkQuery) {
  const types = query.kind ? [workTypes[query.kind]] : Object.values(workTypes);
  let where = "(" + types.map(() => `(r.kind = ? AND ${field("r", "apiVersion")} = ?)`).join(" OR ") + ")";
  const args = types.flatMap(type => ["aide.dev/" + type.kind, type.apiVersion]);
  if (query.state !== "all") {
    where += ` AND ${query.state === "ended" ? "NOT " : ""}EXISTS (SELECT 1 FROM resource_indexes i WHERE i.source = r.key
      AND i.name = CASE r.kind WHEN 'aide.dev/Ongoing' THEN 'openTopic' ELSE 'maintenance' END)`;
  }
  const checkAt = field("r", "status.nextCheckAt");
  const order = query.kind === "ongoing" && (query.state ?? "active") === "active"
    ? `${checkAt} IS NULL, julianday(${checkAt})` : "r.created DESC";
  const joins = topicJoin(`coalesce(${field("r", "spec.topic.uid")}, ${field("r", "status.topic.uid")})`);
  return selectPage(storage, query, where, args, order, joins, topicColumns, row => {
    const resource = storage.decode("personal", row.data as string).object;
    const topic = { topicId: row.topicId as string | null, topicName: row.topicName as string | null };
    if (resource.kind === "Ongoing") {
      const work = ongoingView(resource as OngoingResource);
      return { ...topic, kind: work.kind, uid: work.uid, id: work.id, title: work.title, status: work.status,
        question: work.question, progress: work.progress, checkAt: work.checkAt, outcome: work.closure?.outcome };
    }
    const work = resource as WorkResource;
    const kind = work.kind === "Task" ? "task" as const : "routine" as const;
    return { ...topic, kind, uid: work.metadata.uid, id: work.metadata.name, title: work.spec.title, status: workPhase(work),
      question: work.status.waiting?.question, progress: work.status.lastReport?.text, instruction: work.spec.instruction, nextAt: workDueAt(work) };
  });
}
export type GateNoteItem = ReturnType<typeof browseGateNotes>["items"][number];
export type GateWorkItem = ReturnType<typeof browseGateWork>["items"][number];
