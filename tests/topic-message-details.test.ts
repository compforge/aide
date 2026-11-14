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
  classList = { add: (name: string) => { this.className += " " + name; }, remove: (name: string) => { this.className = this.className.split(" ").filter(n => n !== name).join(" "); } };
  get childNodes() { return this.children; }
  focus() {}
  insertBefore(node: Node, before?: Node) { node.remove(); node.parent = this; const at = before ? this.children.indexOf(before) : -1; if (at < 0) this.children.push(node); else this.children.splice(at, 0, node); }
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

/** @case Transcript bodies are bounded and cached; only the selected execution fetches details, and stale responses cannot cross selection. */
test("Transcript loads bodies while the shared process pane retains selection and expansion", async () => {
  const saved = { document: globalThis.document, fetch: globalThis.fetch, details: globalThis.HTMLDetailsElement, location: globalThis.location, history: globalThis.history };
  const nodes = new Map(["panel-dialogue", "messages", "history", "activity"].map(id => { const node = new Node(); node.id = id; return [id, node]; }));
  nodes.get("messages")!.append(nodes.get("history")!, nodes.get("activity")!);
  nodes.get("panel-dialogue")!.append(nodes.get("messages")!);
  globalThis.document = Object.assign(new EventTarget(), { getElementById: (id: string) => nodes.get(id), createElement: (tag: string) => tag === "details" ? new Details() : new Node(tag) }) as unknown as Document;
  globalThis.HTMLDetailsElement = Details as unknown as typeof HTMLDetailsElement;
  globalThis.location = { href: "http://aide.test/gate" } as Location;
  globalThis.history = { replaceState(_a: unknown, _b: string, url: string) { globalThis.location.href = String(url); } } as unknown as History;
  const calls: { url: string; signal?: AbortSignal; resolve: (value: Response) => void }[] = [];
  globalThis.fetch = ((url: string, options?: RequestInit) => new Promise<Response>(resolve => calls.push({ url, signal: options?.signal ?? undefined, resolve }))) as typeof fetch;
  const scope = new AbortController();
  try {
    const timeline = createTimeline("gate", scope.signal);
    const view: TopicView = { version: "1.0", biz: "aide.topic", meta: { topic_id: "gate", topic_uid: "topic-uid", activity: null }, blocks: Array.from({ length: 5 }, (_, i) => ({
      id: `message:${i}`, type: "message", role: "aide", content: "", at: "2026-11-13T00:00:00Z", group_id: `run-${i}`,
      lazy: { topicUid: "topic-uid", uid: `uid-${i}`, version: "1" },
    })) };
    const history = nodes.get("history")!;
    timeline.render(view); assert.equal(calls.length, 3, "At most three body reads in flight");
    assert(calls.every(c => c.url.startsWith("/topics/message?")));
    const row = history.children[0]!;
    const full = { ...view, blocks: [{ ...view.blocks[0]!, lazy: undefined, content: "**Complete body**" }] };
    calls[0]!.resolve(new Response(JSON.stringify(full))); await settle();
    assert.match(row.text(), /<strong>Complete body<\/strong>/); assert.equal(calls.length, 4);
    timeline.render(view); assert.equal(history.children[0], row); assert.equal(calls.length, 4);
    row.querySelector(".process-link")!.dispatchEvent(new Event("click"));
    const firstProcess = calls.at(-1)!; assert.match(firstProcess.url, /executionId=run-0/);
    history.children[1]!.querySelector(".process-link")!.dispatchEvent(new Event("click"));
    assert.equal(firstProcess.signal!.aborted, true);
    const secondProcess = calls.at(-1)!;
    const processView = { ...view, blocks: [{ id: "execution:two", type: "execution", content: "过程", group_id: "run-1", status: "completed" },
      { id: "tool:two", type: "tool", parent_id: "execution:two", content: "read", detail: "correct result", status: "completed" }] };
    secondProcess.resolve(new Response(JSON.stringify(processView))); await settle();
    firstProcess.resolve(new Response(JSON.stringify({ ...processView, blocks: [{ ...processView.blocks[0], group_id: "run-0", detail: "stale result" }] }))); await settle();
    const pane = nodes.get("panel-dialogue")!.querySelector(".process-pane")!;
    assert.match(pane.text(), /correct result/); assert.doesNotMatch(pane.text(), /stale result/);
    const step = pane.querySelector("details") as Details; step.open = true;
    timeline.render({ ...view, meta: { ...view.meta, activity: { id: "new-run", phase: "running", queued: 0 } } });
    assert.equal(step.open, true); assert.match(globalThis.location.href, /process=run-1/);
    const count = calls.length; timeline.pause(); timeline.show(); assert.equal(calls.length, count + 1);
    calls.at(-1)!.resolve(new Response(JSON.stringify(processView))); await settle(); assert.equal(step.open, true);
    pane.querySelector("button")!.dispatchEvent(new Event("click")); assert.equal(pane.hidden, true);
    assert(!globalThis.location.href.includes("process="));
    scope.abort(); assert(calls.slice(1, 4).every(c => c.signal!.aborted));
  } finally {
    scope.abort(); globalThis.document = saved.document; globalThis.fetch = saved.fetch; globalThis.HTMLDetailsElement = saved.details;
    globalThis.location = saved.location; globalThis.history = saved.history;
  }
});
