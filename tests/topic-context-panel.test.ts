import assert from "node:assert/strict";
import { test } from "node:test";
import { createTopicContextPanel } from "../src/web/topics/context.ts";

// Minimal document surface for exercising request ownership without a browser dependency.
class Node {
  innerHTML = "";
  textContent = "";
  className = "";
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
    assert.equal(calls.length, 1); assert.match(calls[0]!.url, /\/topics\/recent\?/);
    calls[0]!.resolve(new Response(JSON.stringify([])));
    await loading; assert.match(recent.text(), /暂无近期记录/);
    const fail = panel.load("summary");
    calls[1]!.resolve(new Response(JSON.stringify({ error: "Unavailable" }), { status: 500 }));
    await fail; assert.match(summary.text(), /加载失败/); assert.doesNotMatch(summary.text(), /尚未形成/);
    const success = panel.load("summary"); calls[2]!.resolve(new Response(JSON.stringify({ summary: "相同摘要" })));
    await success; assert.match(summary.text(), /相同摘要/);
    const late = panel.load("recent"); scope.abort();
    const next = createTopicContextPanel("second", new AbortController().signal);
    calls[3]!.resolve(new Response(JSON.stringify([]))); await late;
    assert.match(recent.text(), /加载中/);
    const same = next.load("summary"); calls[4]!.resolve(new Response(JSON.stringify({ summary: "相同摘要" })));
    await same; assert.match(summary.text(), /相同摘要/); assert.doesNotMatch(summary.text(), /加载中/);
  } finally { globalThis.document = savedDocument; globalThis.fetch = savedFetch; }
});
