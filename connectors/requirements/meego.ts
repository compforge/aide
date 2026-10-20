import { execFile } from "node:child_process";

import { loadMeegoRequirementConfigs, nonEmptyString, commandIdentifier, type MeegoRequirementConfig } from "./meego/config.ts";
export { loadMeegoRequirementConfigs, type MeegoRequirementConfig } from "./meego/config.ts";
import type {
  Requirement,
  RequirementConnector,
  RequirementIdentity,
  RequirementListQuery,
  RequirementState,
  RequirementSummary,
} from "./protocol.ts";

const MEEGLE_TIMEOUT_MS = 20_000;
const MEEGLE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export type MeegleCliRunner = (args: readonly string[]) => Promise<unknown>;

function optionalObject(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Readonly<Record<string, unknown>>;
}

function defaultMeegleCliRunner(
  args: readonly string[],
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      "meegle",
      [...args],
      {
        encoding: "utf8",
        timeout: MEEGLE_TIMEOUT_MS,
        maxBuffer: MEEGLE_MAX_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          if ("code" in error && error.code === "ENOENT") {
            reject(
              new Error(
                "Meegle CLI is not installed; run `npx @lark-project/meegle@latest install`",
              ),
            );
            return;
          }
          reject(
            new Error(
              `Meegle CLI failed: ${stderr.trim() || error.message}`,
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch (error) {
          if (args[0] === "config" && args[1] === "get") {
            resolve(stdout.trim());
            return;
          }
          const detail = error instanceof Error ? error.message : String(error);
          reject(new Error(`Meegle CLI returned invalid JSON: ${detail}`));
        }
      },
    );
  });
}

function fieldValue(
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
        return record.field_value ?? record.value;
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

function textValue(value: unknown): string | undefined {
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

function requirementRecord(
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

function collectRequirementRecords(value: unknown): readonly Readonly<
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

function operatorMembers(
  item: Readonly<Record<string, unknown>>,
): unknown {
  const roles = item.role_members;
  if (!Array.isArray(roles)) return undefined;
  return roles
    .map((role) => optionalObject(role))
    .find((role) => role?.key === "operator")
    ?.members;
}

function mapSummary(
  source: string,
  category: string,
  item: Readonly<Record<string, unknown>>,
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
  const assignee = peopleValue(
    fieldValue(item, [
      "current_status_operator",
      "current_owners",
      "owners",
      "assignee",
      "assignees",
    ]),
  ) ?? peopleValue(operatorMembers(item));
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
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function workItemUrl(
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

/** Only stable user keys count as ownership; display names and participation are not assignment. */
function userKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(userKeys);
  if (typeof value === "string") return [value];
  const row = optionalObject(value);
  if (!row) return [];
  for (const key of ["user_key", "userKey", "id", "key"]) {
    if (typeof row[key] === "string") return [row[key] as string];
  }
  return [];
}

function stringList(value: unknown): readonly string[] | undefined {
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

export class MeegleCliRequirementConnector
  implements RequirementConnector {
  readonly provider = "meego";
  readonly source: string;

  constructor(
    readonly config: MeegoRequirementConfig,
    private readonly run: MeegleCliRunner = defaultMeegleCliRunner,
  ) {
    this.source = config.source;
  }

  private command(...args: readonly string[]): readonly string[] {
    return [
      ...args,
      "--format",
      "json",
      ...(this.config.profile
        ? ["--profile", this.config.profile]
        : []),
    ];
  }

  async list(
    query: RequirementListQuery = {},
  ): Promise<readonly RequirementSummary[]> {
    const responses = await Promise.all(
      this.config.categories.map(async (category) => {
        const mql = [
          `SELECT \`work_item_id\`, \`name\`, \`${commandIdentifier("assigneeField", this.config.assigneeField ?? "current_status_operator")}\`,`,
          "`work_item_status`, `updated_at`",
          `FROM \`${this.config.projectKey}\`.\`${category}\``,

          "ORDER BY `updated_at` DESC",
          "LIMIT 50",
        ].join(" ");
        const response = await this.run(
          this.command(
            "workitem",
            "query",
            "--project-key",
            this.config.projectKey,
            "--mql",
            mql,
          ),
        );
        const records = collectRequirementRecords(response);
        const assigneeField = this.config.assigneeField ?? "current_status_operator";
        if (query.assigneeUserKeys?.length && records.length && records.every((item) => fieldValue(item, [assigneeField]) === undefined)) {
          throw new Error(`Meego results do not expose configured assignee field ${assigneeField}`);
        }
        return records
          .filter((item) => !query.assigneeUserKeys || userKeys(fieldValue(item, [assigneeField]))
            .some((key) => query.assigneeUserKeys!.includes(key)))
          .map((item) =>
          mapSummary(this.source, category, item)
        );
      }),
    );
    const text = query.text?.trim().toLowerCase();
    const requirements = responses
      .flat()
      .sort((left, right) =>
        (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
      )
      .filter((requirement) =>
        !text || requirement.title.toLowerCase().includes(text)
      );
    return requirements.slice(0, query.limit ?? requirements.length);
  }

  async get(identity: RequirementIdentity): Promise<Requirement> {
    if (identity.source !== this.source) {
      throw new Error(
        `requirement belongs to ${identity.source}, not ${this.source}`,
      );
    }
    const response = await this.run(
      this.command(
        "workitem",
        "get",
        "--project-key",
        this.config.projectKey,
        "--work-item-id",
        identity.id,
        "--fields",
        '["description"]',
      ),
    );
    const record = collectRequirementRecords(response)[0] ??
      requirementRecord(response);
    if (!record) {
      throw new Error(
        `Meegle CLI returned no requirement for ${identity.id}`,
      );
    }
    const summary = mapSummary(this.source, identity.category, record);
    const description = textValue(
      fieldValue(record, ["description", "需求描述", "details"]),
    );
    const acceptanceCriteria = stringList(
      fieldValue(record, [
        "acceptance_criteria",
        "acceptanceCriteria",
        "验收标准",
      ]),
    );
    const host = await this.run(
      this.command("config", "get", "host"),
    );
    return {
      ...summary,
      url: workItemUrl(host, this.config.projectKey, identity),
      ...(description ? { description } : {}),
      ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
    };
  }
}

export function createMeegoRequirementConnectors(
  config: Readonly<Record<string, unknown>>,
  run?: MeegleCliRunner,
): readonly RequirementConnector[] {
  return loadMeegoRequirementConfigs(config).map(
    (config) => new MeegleCliRequirementConnector(config, run),
  );
}
