import { z } from "zod";
import { loadMeegoRequirementConfigs, commandIdentifier, type MeegoRequirementConfig } from "./meego/config.ts";
import { defaultMeegleCliRunner, type MeegleCliRunner } from "./meego/cli.ts";
import { collectRequirementRecords, commentRecord, deliveryMarker, fieldValue, isoTime, mapSummary, records, requirementRecord, stringList, textValue, unwrap, workItemUrl } from "./meego/mapping.ts";
import type { Requirement, RequirementAccount, RequirementComment, RequirementCommentQuery, RequirementConnector, RequirementIdentity, RequirementListQuery, RequirementPage, RequirementSummary } from "./protocol.ts";
export { loadMeegoRequirementConfigs, type MeegoRequirementConfig } from "./meego/config.ts";
export type { MeegleCliRunner } from "./meego/cli.ts";

const Cursor = z.object({ query: z.string(), category: z.number().int().nonnegative(), page: z.number().int().positive(),
  session: z.string().optional(), group: z.string().optional(), total: z.number().int().nonnegative().optional() }).strict();
const CommentCursor = z.object({ query: z.string(), page: z.number().int().positive(), seen: z.number().int().nonnegative() }).strict();
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
const terminalPage = (response: unknown, seen: number, length: number): boolean => {
  const rows = records(response);
  const total = rows.find((r) => typeof r.total === "number" || typeof r.total_count === "number");
  const more = rows.find((r) => typeof r.has_more === "boolean");
  const expected = total ? Number(total.total ?? total.total_count) : undefined;
  if (!length && (more?.has_more === true || (expected !== undefined && seen < expected))) {
    throw new Error("Incomplete Meego comments; observation watermark retained");
  }
  if (more) return !more.has_more;
  if (expected !== undefined) return seen >= expected;
  // An empty final page proves exhaustion when the service supplies no pagination metadata.
  return length === 0;
};

/** @spec Provider cursors bind the query; paging never restarts MQL with a new query. */
export class MeegleCliRequirementConnector implements RequirementConnector {
  readonly provider = "meego";
  readonly source: string;
  private account?: Promise<RequirementAccount & { projectKey: string; host: string }>;
  constructor(readonly config: MeegoRequirementConfig, private readonly run: MeegleCliRunner = defaultMeegleCliRunner) { this.source = config.source; }
  private command(...args: readonly string[]) { return [...args, "--format", "json", ...(this.config.profile ? ["--profile", this.config.profile] : [])]; }
  private async call(...args: string[]) { return unwrap(await this.run(this.command(...args))); }
  identity(): Promise<RequirementAccount & { projectKey: string; host: string }> {
    if (!this.account) this.account = this.resolveAccount().catch((error) => { this.account = undefined; throw error; });
    return this.account;
  }
  private async resolveAccount() {
    const host = String(await this.call("config", "get", "host")).trim();
    const origin = new URL(host.includes("://") ? host : `https://${host}`).origin;
    const response = await this.call("project", "search", "--project-key", this.config.projectKey);
    const projects = records(response).filter((r) => typeof r.project_key === "string");
    const project = projects.find((r) => r.project_key === this.config.projectKey || r.simple_name === this.config.projectKey)
      ?? (projects.length === 1 ? projects[0] : undefined);
    if (!project) throw new Error("Meego project identity is missing or ambiguous");
    const projectKey = commandIdentifier("projectKey", String(project.project_key));
    return { provider: this.provider, scope: `${origin}/${encodeURIComponent(projectKey)}`, projectKey, host: origin };
  }
  private validate(identity: RequirementIdentity) {
    if (identity.source !== this.source) throw new Error(`requirement belongs to ${identity.source}, not ${this.source}`);
    if (!this.config.categories.includes(identity.category)) throw new Error("Requirement category is not configured");
    commandIdentifier("work item id", identity.id);
  }
  async list(query: RequirementListQuery = {}): Promise<RequirementPage<RequirementSummary>> {
    if (query.assigneeUserKeys?.length === 0) return { items: [] };
    const account = await this.identity();
    const signature = JSON.stringify([account.scope, this.config.categories, this.config.assigneeField, query.assigneeUserKeys, query.updatedAfter, query.updatedBefore, query.text]);
    const cursor = query.cursor ? Cursor.parse(decode(query.cursor)) : { query: signature, category: 0, page: 1 };
    if (cursor.query !== signature) throw new Error("Requirement cursor does not match query");
    const category = this.config.categories[cursor.category];
    if (!category) throw new Error("Requirement cursor category is invalid");
    const assigneeField = commandIdentifier("assigneeField", this.config.assigneeField ?? "current_status_operator");
    const args = ["workitem", "query", "--project-key", account.projectKey];
    if (cursor.session) args.push("--session-id", cursor.session, "--params", JSON.stringify({ group_pagination_list: [{ group_id: cursor.group ?? "1", page_num: cursor.page }] }));
    else {
      const where: string[] = [];
      if (query.updatedAfter) where.push(`\`updated_at\` >= '${isoTime(query.updatedAfter)}'`);
      if (query.updatedBefore) where.push(`\`updated_at\` <= '${isoTime(query.updatedBefore)}'`);
      if (query.assigneeUserKeys?.length) where.push(`any_match(\`${assigneeField}\`, x -> x in (${query.assigneeUserKeys.map((key) => `'<id:${commandIdentifier("user key", key)}>'`).join(", ")}))`);
      args.push("--mql", `SELECT \`work_item_id\`, \`name\`, \`${assigneeField}\`, \`work_item_status\`, \`updated_at\` FROM \`${account.projectKey}\`.\`${category}\`${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY \`updated_at\` ASC`);
    }
    const response = await this.call(...args);
    const raw = collectRequirementRecords(response);
    if (query.assigneeUserKeys?.length && raw.some((row) => fieldValue(row, [assigneeField]) === undefined)) throw new Error(`Meego results do not expose configured assignee field ${assigneeField}`);
    const items = raw.map((row) => mapSummary(this.source, category, row, assigneeField))
      .filter((row) => !query.assigneeUserKeys || row.assignees?.some((user) => query.assigneeUserKeys!.includes(user.key)))
      .filter((row) => !query.text || row.title.toLowerCase().includes(query.text.toLowerCase()));
    const metadata = records(response);
    const count = metadata.find((row) => typeof row.count === "number");
    const total = count ? Number(count.count) : cursor.total;
    if (total !== undefined && raw.length !== Math.max(0, Math.min(50, total - (cursor.page - 1) * 50))) {
      throw new Error("Incomplete Meego page; scan watermark retained");
    }
    const more = total !== undefined ? cursor.page * 50 < total : raw.length === 50;
    let next: z.infer<typeof Cursor> | undefined;
    if (more) {
      const session = textValue(metadata.find((row) => row.session_id)?.session_id) ?? cursor.session;
      if (!session || raw.length === 0) throw new Error("Incomplete Meego page; scan watermark retained");
      next = { ...cursor, page: cursor.page + 1, session, group: textValue(metadata.find((row) => row.group_id)?.group_id) ?? cursor.group ?? "1", ...(total !== undefined ? { total } : {}) };
    } else if (cursor.category + 1 < this.config.categories.length) next = { query: signature, category: cursor.category + 1, page: 1 };
    return { items, ...(next ? { nextCursor: encode(next) } : {}) };
  }
  async get(identity: RequirementIdentity): Promise<Requirement> {
    this.validate(identity);
    const account = await this.identity();
    const response = await this.call("workitem", "get", "--project-key", account.projectKey, "--work-item-id", identity.id, "--fields", JSON.stringify(["description", this.config.assigneeField ?? "current_status_operator"]));
    const record = collectRequirementRecords(response)[0] ?? requirementRecord(response);
    if (!record) throw new Error(`Meegle CLI returned no requirement for ${identity.id}`);
    const summary = mapSummary(this.source, identity.category, record, this.config.assigneeField);
    if (summary.assignees === undefined) throw new Error(`Meego details do not expose configured assignee field ${this.config.assigneeField ?? "current_status_operator"}`);
    if (summary.id !== identity.id) throw new Error("Meego returned a different work item");
    const description = textValue(fieldValue(record, ["description", "需求描述", "details"]));
    const acceptanceCriteria = stringList(fieldValue(record, ["acceptance_criteria", "acceptanceCriteria", "验收标准"]));
    return { ...summary, url: workItemUrl(account.host, account.projectKey, identity), ...(description ? { description } : {}), ...(acceptanceCriteria ? { acceptanceCriteria } : {}) };
  }
  async comments(identity: RequirementIdentity, query: RequirementCommentQuery = {}): Promise<RequirementPage<RequirementComment>> {
    this.validate(identity);
    const account = await this.identity();
    const signature = JSON.stringify([account.scope, identity, query.start, query.end]);
    const cursor = query.cursor ? CommentCursor.parse(decode(query.cursor)) : { query: signature, page: 1, seen: 0 };
    if (cursor.query !== signature) throw new Error("Comment cursor does not match query");
    const args = ["comment", "list", "--project-key", account.projectKey, "--work-item-id", identity.id, "--page-num", String(cursor.page)];
    if (query.start) args.push("--start-time", String(Date.parse(isoTime(query.start)!)));
    if (query.end) args.push("--end-time", String(Date.parse(isoTime(query.end)!)));
    const response = await this.call(...args);
    const raw = records(response).filter((row) => (row.comment_id !== undefined || row.id !== undefined) && (row.content !== undefined || row.text !== undefined));
    const items = raw.map(commentRecord);
    return { items, ...(!terminalPage(response, cursor.seen + raw.length, raw.length) ? { nextCursor: encode({ query: signature, page: cursor.page + 1, seen: cursor.seen + raw.length }) } : {}) };
  }
  async addComment(identity: RequirementIdentity, comment: { text: string; deliveryId: string }) {
    this.validate(identity);
    const account = await this.identity();
    const response = await this.call("comment", "add", "--project-key", account.projectKey, "--work-item-id", identity.id,
      "--content", `${comment.text}\n\n${deliveryMarker(comment.deliveryId)}`);
    const row = records(response).find((row) => row.comment_id !== undefined || row.id !== undefined);
    const id = textValue(row?.comment_id ?? row?.id);
    if (!id) throw new Error("Meego accepted comment without a usable receipt; verify delivery before retrying");
    return { id, scope: account.scope };
  }
}
