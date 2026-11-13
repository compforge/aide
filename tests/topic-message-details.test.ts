import assert from "node:assert/strict";
import { test } from "node:test";
import { createTimeline } from "../src/web/topics/timeline.ts";
import type { TopicView } from "../src/channel/view.ts";

// Exercise request ownership and mounted-node reuse without adding a browser dependency.
class Node extends EventTarget {
  constructor(readonly tag = "div") { super(); }
  id = ""; className = ""; innerHTML = ""; textContent = ""; hidden = false;
  dataset: Record<string, string> = {}; children: Node[] = []; parent?: Node;
  scrollTop = 0; scrollHeight = 500; clientHeight = 100;
  classList = { add: (name: string) => { this.className += " " + name; } };
  setAttribute() {}
  getBoundingClientRect() { return { top: 0, bottom: 100 }; }
  append(...nodes: Node[]) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: Node[]) { this.children.forEach(node => { node.parent = undefined; }); this.children = []; this.innerHTML = ""; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  querySelectorAll(selector: string): Node[] {
    const matches = (node: Node) => selector.split(", ").some(part => part === "[data-scroll-key]" ? !!node.dataset.scrollKey
      : part.startsWith(".") ? node.className.split(" ").includes(part.slice(1)) : node.tag === part);
    return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0]; }
  text(): string { return this.textContent + this.innerHTML + this.children.map(node => node.text()).join(""); }
}
class Details extends Node {
  constructor() { super("details"); }
  open = false;
  toggle() { this.open = !this.open; this.dispatchEvent(new Event("toggle")); }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** @case Collapsed messages do no detail work; reopens reuse content, failures retry and retired requests cannot render. */
test("Message details load on expansion and retain request ownership across updates", async () => {
  const saved = { document: globalThis.document, fetch: globalThis.fetch, details: globalThis.HTMLDetailsElement };
  const nodes = new Map(["messages", "history", "activity"].map(id => { const node = new Node(); node.id = id; return [id, node]; }));
  nodes.get("messages")!.append(nodes.get("history")!, nodes.get("activity")!);
  globalThis.document = { getElementById: (id: string) => nodes.get(id), createElement: (tag: string) => tag === "details" ? new Details() : new Node(tag),
    createElementNS: (_namespace: string, tag: string) => new Node(tag) } as unknown as Document;
  globalThis.HTMLDetailsElement = Details as unknown as typeof HTMLDetailsElement;
  const calls: { url: string; signal?: AbortSignal; resolve: (value: Response) => void }[] = [];
  globalThis.fetch = ((url: string, options?: RequestInit) => new Promise<Response>(resolve => calls.push({ url, signal: options?.signal ?? undefined, resolve }))) as typeof fetch;
  try {
    const scope = new AbortController(), timeline = createTimeline("topic", scope.signal);
    const view: TopicView = { version: "1.0", biz: "aide.topic", meta: { topic_id: "topic", activity: null }, blocks: [{
      id: "input:first", type: "input", inputId: "first", content: "short preview", at: "2026-11-13T00:00:00Z", status: "done",
      lazy: { topicUid: "topic-uid", uid: "input-uid", version: "1" },
    }] };
    const history = nodes.get("history")!;
    timeline.render(view);
    assert.equal(calls.length, 0); assert.equal(history.querySelector(".message-body"), undefined);
    const row = history.children[0] as Details; row.toggle();
    assert.equal(calls.length, 1); assert.match(calls[0]!.url, /\/topics\/message\?/);
    row.toggle(); row.toggle(); assert.equal(calls.length, 1, "An in-flight detail is not fetched twice");
    const full = { ...view, blocks: [{ ...view.blocks[0], lazy: undefined, content: "**Complete body**" }] };
    calls[0]!.resolve(new Response(JSON.stringify(full))); await settle();
    assert.match(row.text(), /<strong>Complete body<\/strong>/);
    row.toggle(); row.toggle(); assert.equal(calls.length, 1, "Reopening reuses the loaded detail");
    timeline.render({ ...view, blocks: [...view.blocks, { ...view.blocks[0]!, id: "input:second" }] });
    assert.equal(history.children[0], row, "Unrelated arrivals retain the mounted detail node");
    const revised = { ...view, blocks: [{ ...view.blocks[0]!, lazy: { ...view.blocks[0]!.lazy!, version: "2" } }] };
    timeline.render(revised); assert.equal(calls.length, 2, "An open changed message reloads its detail");
    const changedRow = history.children[0] as Details;
    calls[1]!.resolve(new Response(JSON.stringify({ error: "Temporary failure" }), { status: 503 })); await settle();
    assert.match(changedRow.text(), /Temporary failure/);
    changedRow.querySelector("button")!.dispatchEvent(new Event("click")); assert.equal(calls.length, 3);
    // Replace the row while its retry is in flight; the old request cannot render into the replacement.
    const newest = { ...revised, blocks: [{ ...revised.blocks[0]!, lazy: { ...revised.blocks[0]!.lazy!, version: "3" } }] };
    timeline.render(newest); assert.equal(calls.length, 4);
    calls[2]!.resolve(new Response(JSON.stringify(full))); await settle();
    assert.doesNotMatch(history.text(), /Complete body/);
    scope.abort(); assert.equal(calls[3]!.signal!.aborted, true);
    history.replaceChildren(new Node());
    calls[3]!.resolve(new Response(JSON.stringify(full))); await settle();
    assert.doesNotMatch(history.text(), /Complete body/);
  } finally {
    globalThis.document = saved.document; globalThis.fetch = saved.fetch; globalThis.HTMLDetailsElement = saved.details;
  }
});
