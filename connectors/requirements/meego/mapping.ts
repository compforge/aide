import type { RequirementSummary, RequirementIdentity, RequirementState, RequirementUser, RequirementComment } from "../protocol.ts";
import { nonEmptyString } from "./config.ts";
export function optionalObject(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Readonly<Record<string, unknown>>;
}


export function fieldValue(
  item: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (item[key] !== undefined) return item[key];
  }
  const fields = item.fields;
  if (Array.isArray(fields)) {
    for (const field of fields) {
      const record = optionalObject(field);
      if (!record) continue;
      const key = record.field_key ?? record.key ?? record.name;
      if (typeof key === "string" && keys.includes(key)) {
        return record.field_value !== undefined ? record.field_value : record.value;
      }
    }
  }
  const fieldMap = optionalObject(fields);
  if (fieldMap) {
    for (const key of keys) {
      if (fieldMap[key] !== undefined) return fieldMap[key];
    }
  }
  return undefined;
}

function meegleFieldValue(value: unknown): unknown {
  const record = optionalObject(value);
  if (!record) return value;
  for (const key of [
    "string_value",
    "long_value",
    "double_value",
    "bool_value",
    "user_value_list",
    "key_label_value_list",
  ]) {
    if (record[key] !== undefined) return record[key];
  }
  return value;
}

function moqlRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const record = optionalObject(value);
  if (!record || !Array.isArray(record.moql_field_list)) return undefined;
  const result: Record<string, unknown> = {};
  for (const rawField of record.moql_field_list) {
    const field = optionalObject(rawField);
    if (!field || typeof field.key !== "string") continue;
    result[field.key] = meegleFieldValue(field.value);
  }
  return result;
}

export function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textValue(item);
      if (text) return text;
    }
    return undefined;
  }
  const record = optionalObject(value);
  if (!record) return undefined;
  for (const key of [
    "name",
    "name_cn",
    "name_en",
    "label",
    "value",
    "key",
  ]) {
    const text = textValue(record[key]);
    if (text) return text;
  }
  return undefined;
}

function peopleValue(value: unknown): string | undefined {
  const values = Array.isArray(value) ? value : [value];
  const people = values
    .map((person) => textValue(person))
    .filter((person): person is string => Boolean(person));
  return people.length ? people.join(", ") : undefined;
}

function requirementState(value: unknown): RequirementState {
  const raw = textValue(value)?.toLowerCase();
  if (!raw) return "unknown";
  if (
    raw.includes("closed") ||
    raw.includes("cancel") ||
    raw.includes("abort") ||
    raw.includes("关闭") ||
    raw.includes("终止") ||
    raw.includes("取消")
  ) {
    return "closed";
  }
  if (["completed", "complete", "done", "resolved", "已完成", "完成", "已解决"].includes(raw)) return "completed";
  if (
    raw.includes("progress") ||
    raw.includes("doing") ||
    raw.includes("进行") ||
    raw.endsWith("中")
  ) {
    return "in_progress";
  }
  if (
    raw.includes("open") ||
    raw.includes("todo") ||
    raw.includes("pending") ||
    raw.startsWith("待") ||
    raw.includes("重新打开") ||
    raw.includes("待处理") ||
    raw.includes("未开始")
  ) {
    return "open";
  }
  return "unknown";
}

export function requirementRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const record = optionalObject(value);
  if (!record) return undefined;
  const moql = moqlRecord(record);
  if (moql) return moql;
  const attribute = optionalObject(record.work_item_attribute);
  if (attribute) {
    return {
      ...attribute,
      fields: record.work_item_fields,
    };
  }
  const nested = optionalObject(record.data);
  return nested && fieldValue(nested, ["work_item_id", "id"]) !== undefined
    ? nested
    : record;
}

export function collectRequirementRecords(value: unknown): readonly Readonly<
  Record<string, unknown>
>[] {
  const records: Readonly<Record<string, unknown>>[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    const record = requirementRecord(candidate);
    if (!record) return;
    const id = fieldValue(record, ["work_item_id", "id"]);
    const title = fieldValue(record, [
      "name",
      "title",
      "work_item_name",
    ]);
    if (id !== undefined && title !== undefined) {
      records.push(record);
      return;
    }
    for (const key of [
      "data",
      "list",
      "items",
      "results",
      "work_items",
      "group_infos",
    ]) {
      if (record[key] !== undefined) visit(record[key]);
    }
    for (const [key, nested] of Object.entries(record)) {
      if (/^\d+$/.test(key)) visit(nested);
    }
  };
  visit(value);
  return records;
}

export function mapSummary(
  source: string,
  category: string,
  item: Readonly<Record<string, unknown>>,
  assigneeField = "current_status_operator",
): RequirementSummary {
  const id = textValue(fieldValue(item, ["work_item_id", "id"]));
  const title = textValue(
    fieldValue(item, ["name", "title", "work_item_name"]),
  );
  if (!id || !title) {
    throw new Error(
      `Meegle CLI returned a ${category} without an id or title`,
    );
  }
  const owner = fieldValue(item, [assigneeField]);
  const assignees = owner === undefined ? undefined : users(owner);
  const assignee = peopleValue(owner);
  const updatedAt = textValue(
    fieldValue(item, ["updated_at", "updatedAt", "update_time"]),
  );
  return {
    source,
    category,
    id,
    title,
    state: requirementState(
      fieldValue(item, ["status", "work_item_status", "state"]),
    ),
    ...(assignee ? { assignee } : {}),
    ...(assignees ? { assignees } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function workItemUrl(
  host: unknown,
  projectKey: string,
  identity: RequirementIdentity,
): string {
  const normalizedHost = nonEmptyString("Meegle CLI host", host).trim();
  const baseUrl = new URL(
    normalizedHost.includes("://")
      ? normalizedHost
      : `https://${normalizedHost}`,
  );
  return new URL(
    [
      encodeURIComponent(projectKey),
      encodeURIComponent(identity.category),
      "detail",
      encodeURIComponent(identity.id),
    ].join("/"),
    `${baseUrl.protocol}//${baseUrl.host}/`,
  ).toString();
}

export function stringList(value: unknown): readonly string[] | undefined {
  if (Array.isArray(value)) {
    const values = value
      .map((item) => textValue(item))
      .filter((item): item is string => Boolean(item));
    return values.length ? values : undefined;
  }
  const text = textValue(value);
  if (!text) return undefined;
  const values = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}


/** Only stable platform keys establish people; display names alone are not identities. */
export function users(value: unknown): RequirementUser[] {
  if (Array.isArray(value)) return value.flatMap(users);
  if (typeof value === "string") return [{ key: value }];
  const row = optionalObject(value);
  if (!row) return [];
  const key = row.user_key ?? row.userKey ?? row.key ?? row.id;
  if (typeof key !== "string" || !key) return [];
  const name = textValue(row.name ?? row.name_cn ?? row.name_en);
  return [{ key, ...(name ? { name } : {}) }];
}
export function unwrap(value: unknown): unknown {
  const row = optionalObject(value);
  if (!row) return value;
  if ((typeof row.code === "number" && row.code !== 0) || (typeof row.err_code === "number" && row.err_code !== 0)) {
    throw new Error(`Meegle request failed: ${row.code ?? row.err_code}`);
  }
  return row.data === undefined ? row : unwrap(row.data);
}
export function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(records);
  const row = optionalObject(value);
  return row ? [row, ...Object.values(row).flatMap(records)] : [];
}
export function isoTime(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" || /^\d+$/.test(String(value)) ? Number(value) : undefined;
  const date = new Date(n === undefined ? String(value) : n < 100000000000 ? n * 1000 : n);
  if (!Number.isFinite(date.getTime())) throw new Error("Meegle returned an invalid timestamp");
  return date.toISOString();
}
export const deliveryMarker = (id: string) => `<!-- aide-output:${encodeURIComponent(id)} -->`;
export function commentRecord(raw: Record<string, unknown>): RequirementComment {
  const id = textValue(raw.comment_id ?? raw.id);
  const body = raw.content ?? raw.text;
  const content = typeof body === "string" ? body : textValue(optionalObject(body)?.text);
  const createdAt = isoTime(raw.create_time ?? raw.created_at ?? raw.createdAt);
  if (!id || content === undefined || !createdAt) throw new Error("Meegle comment is missing id, content or create time");
  const marker = /<!-- aide-output:([^ ]+) -->\s*$/.exec(content);
  const author = users(raw.author ?? raw.creator ?? raw.created_by ?? raw.user ?? raw.user_key)[0];
  return { id, text: marker ? content.slice(0, marker.index).trimEnd() : content, createdAt,
    ...(isoTime(raw.update_time ?? raw.updated_at) ? { updatedAt: isoTime(raw.update_time ?? raw.updated_at) } : {}),
    ...(author ? { author } : {}), mentions: users(raw.mentions ?? raw.notify_user_list),
    ...(marker ? { deliveryId: decodeURIComponent(marker[1]!) } : {}) };
}
