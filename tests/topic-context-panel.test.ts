import assert from "node:assert/strict";
import { test } from "node:test";
import { createTopicContextPanel } from "../src/web/topics/context.ts";

// Minimal document surface for exercising request ownership without a browser dependency.
class Node {
  innerHTML = "";
  textContent = "";
  className = "";
  disabled = false;
  scrollTop = 0;
  onclick?: () => Promise<void>;
  children: Node[] = [];
  parent?: Node;
  classList = { toggle() {} };
  setAttribute() {}
  append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: Node[]) { this.innerHTML = ""; this.textContent = ""; this.children = []; this.append(...nodes); }
  querySelector(selector: string) { return this.children.find(node => node.className.split(" ").includes(selector.split(".").at(-1)!)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  text(): string { return this.innerHTML + this.textContent + this.children.map(node => node.text()).join(""); }
}

/** @case Pending, failed, empty and retired Topic requests are distinct; identical summaries survive switching Topics. */
test("Knowledge panels request only their own data and never mistake loading for empty", async () => {
  const savedDocument = globalThis.document, savedFetch = globalThis.fetch;
  const summary = new Node(), recent = new Node();
  const calls: { url: string; resolve: (value: Response) => void }[] = [];
  globalThis.document = { getElementById: (id: string) => id === "topic-summary" ? summary : recent, createElement: () => new Node() } as unknown as Document;
  globalThis.fetch = ((url: string) => new Promise<Response>(resolve => calls.push({ url, resolve }))) as typeof fetch;
  try {
    const scope = new AbortController();
    const panel = createTopicContextPanel("first", scope.signal);
    assert.match(recent.text(), /加载中/); assert.doesNotMatch(recent.text(), /暂无/);
    const loading = panel.load("recent");
    await panel.load("recent");
    assert.equal(calls.length, 1); assert.match(calls[0]!.url, /\/topics\/notes\?/);
    assert.match(calls[0]!.url, /pageSize=5/);
    calls[0]!.resolve(new Response(JSON.stringify({ items: [], total: 0, page: 1, pages: 1, pageSize: 5 })));
    await loading; assert.match(recent.text(), /暂无近期记录/);
    const fail = panel.load("summary");
    calls[1]!.resolve(new Response(JSON.stringify({ error: "Unavailable" }), { status: 500 }));
    await fail; assert.match(summary.text(), /加载失败/); assert.doesNotMatch(summary.text(), /尚未形成/);
    const success = panel.load("summary"); calls[2]!.resolve(new Response(JSON.stringify({ summary: "相同摘要" })));
    await success; assert.match(summary.text(), /相同摘要/);
    const late = panel.load("recent"); scope.abort();
    const next = createTopicContextPanel("second", new AbortController().signal);
    calls[3]!.resolve(new Response(JSON.stringify({ items: [], total: 0, page: 1, pages: 1, pageSize: 5 }))); await late;
    assert.match(recent.text(), /加载中/);
    const same = next.load("summary"); calls[4]!.resolve(new Response(JSON.stringify({ summary: "相同摘要" })));
    await same; assert.match(summary.text(), /相同摘要/); assert.doesNotMatch(summary.text(), /加载中/);
  } finally { globalThis.document = savedDocument; globalThis.fetch = savedFetch; }
});

/** @case Note paging retains the selected page while polling, retries failed navigation, and clamps after deletion. */
test("Topic Note controls request five records and preserve paging state", async () => {
  const savedDocument = globalThis.document, savedFetch = globalThis.fetch;
  const summary = new Node(), recent = new Node();
  const calls: { url: string; resolve: (value: Response) => void }[] = [];
  globalThis.document = { getElementById: (id: string) => id === "topic-summary" ? summary : recent, createElement: () => new Node() } as unknown as Document;
  globalThis.fetch = ((url: string) => new Promise<Response>(resolve => calls.push({ url, resolve }))) as typeof fetch;
  const result = (page: number, total = 11) => new Response(JSON.stringify({ page, pageSize: 5, total, pages: Math.ceil(total / 5),
    items: [{ updatedAt: "2026-11-14T00:00:00Z", text: `第 ${page} 页内容` }] }));
  const controls = () => recent.querySelector(".note-pages")!.children;
  try {
    const panel = createTopicContextPanel("notes", new AbortController().signal);
    const first = panel.load("recent"); calls[0]!.resolve(result(1)); await first;
    assert.match(calls[0]!.url, /page=1&pageSize=5/);
    assert.equal(controls()[1]!.disabled, true); assert.equal(controls()[2]!.disabled, false);
    recent.scrollTop = 120;
    const next = controls()[2]!.onclick!();
    assert.equal(controls()[2]!.disabled, true);
    assert.match(calls[1]!.url, /page=2&pageSize=5/);
    calls[1]!.resolve(result(2)); await next;
    assert.equal(recent.scrollTop, 0); assert.match(recent.text(), /第 2 \/ 3 页/);
    recent.scrollTop = 80;
    const poll = panel.load("recent"); calls[2]!.resolve(result(2)); await poll;
    assert.match(calls[2]!.url, /page=2&pageSize=5/); assert.equal(recent.scrollTop, 80);
    const failed = controls()[2]!.onclick!();
    calls[3]!.resolve(new Response(JSON.stringify({ error: "Unavailable" }), { status: 500 })); await failed;
    assert.match(recent.text(), /第 2 页内容/); assert.match(recent.text(), /加载失败/);
    const retry = panel.load("recent");
    assert.match(calls[4]!.url, /page=3&pageSize=5/);
    calls[4]!.resolve(result(3)); await retry;
    assert.equal(controls()[2]!.disabled, true); assert.doesNotMatch(recent.text(), /加载失败/);
    const shrink = panel.load("recent"); calls[5]!.resolve(result(2, 6)); await shrink;
    assert.match(recent.text(), /第 2 \/ 2 页/);
    const previous = controls()[1]!.onclick!();
    assert.match(calls[6]!.url, /page=1&pageSize=5/);
    calls[6]!.resolve(result(1, 6)); await previous;
    assert.equal(controls()[1]!.disabled, true);
  } finally { globalThis.document = savedDocument; globalThis.fetch = savedFetch; }
});
