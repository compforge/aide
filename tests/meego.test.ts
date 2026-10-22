import assert from "node:assert/strict";
import { test } from "node:test";
import { MeegleCliRequirementConnector, loadMeegoRequirementConfigs } from "../connectors/requirements/meego.ts";
import { commentRecord } from "../connectors/requirements/meego/mapping.ts";
const config = { source: "work", provider: "meego" as const, projectKey: "alias", categories: ["story"], assigneeField: "owner" };
const metadata = (args: readonly string[]): unknown => args[0] === "config" ? "meego.example.com" : args[0] === "project" ? { projects: [{ project_key: "canonical", simple_name: "alias" }] } : undefined;
const row = (id: number, owner = "me") => ({ work_item_id: id, name: `item-${id}`, owner: [{ user_key: owner, name: "Same name" }], work_item_status: "未完成" });

test("Meego uses canonical scope and real MQL paging without a truncating LIMIT", async () => {
  const calls: string[][] = [];
  const provider = new MeegleCliRequirementConnector(config, async (args) => {
    const meta = metadata(args); if (meta) return meta;
    calls.push([...args]);
    return args.includes("--session-id")
      ? { list: [{ count: 51, group_infos: [{ group_id: "1", items: [row(51)] }] }] }
      : { session_id: "query-1", list: [{ count: 51, group_infos: [{ group_id: "1", items: Array.from({ length: 50 }, (_, i) => row(i + 1)) }] }] };
  });
  assert.equal((await provider.identity()).scope, "https://meego.example.com/canonical");
  const first = await provider.list({ assigneeUserKeys: ["me"] });
  assert.equal(first.items.length, 50); assert.ok(first.nextCursor);
  const second = await provider.list({ assigneeUserKeys: ["me"], cursor: first.nextCursor });
  assert.deepEqual(second.items.map((r) => r.id), ["51"]); assert.equal(second.nextCursor, undefined);
  assert.doesNotMatch(calls[0]!.join(" "), /LIMIT/); assert.match(calls[0]!.join(" "), /<id:me>/);
  assert.ok(calls[1]!.includes("--session-id")); assert.ok(!calls[1]!.includes("--mql"));
  assert.deepEqual(JSON.parse(calls[1]![calls[1]!.indexOf("--params") + 1]!), { group_pagination_list: [{ group_id: "1", page_num: 2 }] });
  await assert.rejects(provider.list({ assigneeUserKeys: ["other"], cursor: first.nextCursor }), /does not match/);
});

test("Meego assignment uses stable keys and configured fields, never display names or participants", async () => {
  const provider = new MeegleCliRequirementConnector(config, async (args) => metadata(args) ?? { data: [row(1), row(2, "other"), { ...row(3), owner: [{ name: "me" }], all_participate_persons: ["me"] }, { ...row(4), work_item_status: "已完成" }] });
  const page = await provider.list({ assigneeUserKeys: ["me"] });
  assert.deepEqual(page.items.map((i) => i.id), ["1", "4"]);
  assert.deepEqual(page.items[0]!.assignees, [{ key: "me", name: "Same name" }]);
  assert.notEqual(page.items[0]!.state, "completed"); assert.equal(page.items[1]!.state, "completed");
  assert.equal((await provider.list()).items.length, 4);
  assert.deepEqual(await provider.list({ assigneeUserKeys: [] }), { items: [] });
  await assert.rejects(provider.get({ source: "other", category: "story", id: "1" }), /belongs to/);
  const missing = new MeegleCliRequirementConnector(config, async (args) => metadata(args) ?? [{ work_item_id: 1, name: "Missing owner" }]);
  await assert.rejects(missing.list({ assigneeUserKeys: ["me"] }), /assignee field/);
});

test("Meego comments freeze the time range across pages and keep authors and mentions", async () => {
  const calls: string[][] = [];
  const provider = new MeegleCliRequirementConnector(config, async (args) => {
    const meta = metadata(args); if (meta) return meta;
    calls.push([...args]);
    return { has_more: calls.length === 1, comments: [{ comment_id: String(calls.length), content: "hello", create_time: 1792627200000,
      creator: { user_key: "zhang", name: "张三" }, mentions: [{ user_key: "me" }] }] };
  });
  const id = { source: "work", category: "story", id: "1" };
  const query = { start: "2026-10-22T00:00:00.000Z", end: "2026-10-22T00:05:00.000Z" };
  const first = await provider.comments(id, query);
  assert.equal(first.items[0]!.author?.key, "zhang"); assert.equal(first.items[0]!.mentions?.[0]?.key, "me");
  const second = await provider.comments(id, { ...query, cursor: first.nextCursor });
  assert.equal(second.nextCursor, undefined); assert.ok(calls[1]!.includes("2"));
  assert.equal(calls[1]![calls[1]!.indexOf("--end-time") + 1], String(Date.parse(query.end)));
  await assert.rejects(provider.comments(id, { ...query, end: "2026-10-23T00:00:00Z", cursor: first.nextCursor }), /does not match/);
});

test("Comment delivery carries correlation and returns a receipt without notifying arbitrary people", async () => {
  let sent: readonly string[] = [];
  const provider = new MeegleCliRequirementConnector(config, async (args) => { const meta = metadata(args); if (meta) return meta; sent = args; return { comment_id: "c-1" }; });
  assert.deepEqual(await provider.addComment({ source: "work", category: "story", id: "1" }, { text: "收到", deliveryId: "out:1" }), { id: "c-1", scope: "https://meego.example.com/canonical" });
  assert.ok(!sent.includes("--notify-user-list"));
  const text = sent[sent.indexOf("--content") + 1]!;
  const mapped = commentRecord({ comment_id: "c-1", content: text, create_time: 1792627200000 });
  assert.equal(mapped.text, "收到"); assert.equal(mapped.deliveryId, "out:1");
});

test("Meego Me configuration is independent of profile and assignee scope", () => {
  const configured = loadMeegoRequirementConfigs({ requirements: { work: { provider: "meego", projectKey: "p", profile: "bot", me: { userKey: "human" } } } });
  assert.equal(configured[0]!.me?.userKey, "human"); assert.equal(configured[0]!.profile, "bot");
  assert.throws(() => loadMeegoRequirementConfigs({ requirements: { work: { provider: "meego", projectKey: "p", me: { name: "someone" } } } }), /Invalid/);
});


test("Detail mapping preserves an empty configured owner and rejects a missing owner instead of substituting participants", async () => {
  let fields: unknown[] = [{ field_key: "owner", field_value: [] }, { field_key: "description", field_value: "detail" }];
  const provider = new MeegleCliRequirementConnector(config, async (args) => metadata(args) ?? {
    work_item_attribute: { work_item_id: 1, name: "request", status: "已完成", role_members: [{ key: "operator", members: ["someone"] }] },
    work_item_fields: fields,
  });
  const identity = { source: "work", category: "story", id: "1" };
  const detail = await provider.get(identity);
  assert.deepEqual(detail.assignees, []); assert.equal(detail.description, "detail"); assert.equal(detail.state, "completed");
  fields = [{ field_key: "description", field_value: "detail" }];
  await assert.rejects(provider.get(identity), /configured assignee field/);
});

test("Partial MQL pages fail closed and comment totals never imply a guessed page size", async () => {
  let calls = 0;
  const provider = new MeegleCliRequirementConnector(config, async (args) => metadata(args) ?? (args[0] === "workitem"
    ? { session_id: "s", list: [{ count: 51, items: [row(1)] }] }
    : { total: 2, comments: [{ comment_id: String(++calls), content: "", create_time: 1792627200000, user_key: "me" }] }));
  await assert.rejects(provider.list(), /Incomplete/);
  const id = { source: "work", category: "story", id: "1" };
  const page = await provider.comments(id);
  assert.ok(page.nextCursor); assert.equal(page.items[0]!.author?.key, "me");
  assert.equal((await provider.comments(id, { cursor: page.nextCursor })).nextCursor, undefined);
});


test("An empty comment page with more results does not advance the caller watermark", async () => {
  const provider = new MeegleCliRequirementConnector(config, async (args) => metadata(args) ?? { has_more: true, comments: [] });
  await assert.rejects(provider.comments({ source: "work", category: "story", id: "1" }), /Incomplete Meego comments/);
});
