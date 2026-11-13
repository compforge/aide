import assert from "node:assert/strict";
import { test } from "node:test";
import { createDialogueHistory } from "../src/web/topics/history.ts";
import { preserveTranscriptPosition } from "../src/web/topics/scroll.ts";
import type { TopicBlock, TopicView } from "../src/channel/view.ts";

function page(first: number, last: number, before: string | null): TopicView {
  return { version: "1.0", biz: "aide.topic", meta: { topic_id: "test", activity: null, before }, blocks: Array.from({ length: last - first + 1 }, (_, i) => {
    const n = i + first;
    return { id: `input:${n}`, inputId: String(n), type: "input", content: String(n), at: new Date(n * 1000).toISOString() };
  }) };
}
const ids = (view: TopicView) => view.blocks.map(b => b.id);

test("Scrolling history prepends pages while live updates retain loaded records and the oldest cursor", () => {
  const history = createDialogueHistory();
  history.live(page(21, 30, "before21"));
  assert.equal(history.view()!.blocks.length, 10);
  const pending = history.next(true)!;
  const newer = page(22, 31, "before22");
  newer.blocks.find(b => b.id === "input:25")!.content = "new status";
  history.live(newer);
  const older = page(11, 25, "before11");
  history.accept(pending, older);
  assert.deepEqual(ids(history.view()!), ids(page(11, 31, null)));
  assert.equal(history.view()!.blocks.find(b => b.id === "input:25")!.content, "new status", "Late history cannot replace a live update");
  assert.equal(history.next(true)!.before, "before11");
  history.accept(history.next(true)!, page(1, 10, null));
  assert.equal(history.hasOlder(), false);
  history.live(page(23, 32, "before23"));
  assert.equal(history.hasOlder(), false);
  assert.deepEqual(ids(history.view()!), ids(page(1, 32, null)));
});

test("A reconnect gap uses bounded pages without skipping history or moving the reading cursor", () => {
  const history = createDialogueHistory();
  history.live(page(21, 30, "before21"));
  history.accept(history.next(true)!, page(11, 20, "before11"));
  history.live(page(51, 60, "before51"));
  assert.equal(history.next(false)!.before, "before51");
  history.accept(history.next(false)!, page(41, 50, "before41"));
  history.accept(history.next(false)!, page(31, 40, "before31"));
  history.accept(history.next(false)!, page(21, 30, "before21"));
  assert.equal(history.hasGap(), false);
  assert.equal(history.next(false), undefined, "Normal older history is fetched only on reader intent");
  assert.equal(history.next(true)!.before, "before11");
  assert.deepEqual(ids(history.view()!), ids(page(11, 60, null)));
});

test("Failed or nonadvancing history retains its cursor for retry; execution children keep their parent ordering", () => {
  const history = createDialogueHistory();
  const execution: TopicBlock = { id: "execution:e", type: "execution", content: "process", status: "running", at: new Date(30_000).toISOString() };
  const child: TopicBlock = { id: "thought:t", parent_id: execution.id, type: "thought", content: "thinking" };
  const live = page(21, 30, "before21"); live.blocks.push(execution, child);
  history.live(live);
  const pending = history.next(true)!;
  assert.throws(() => history.accept(pending, page(11, 20, "before21")), /did not advance/);
  assert.equal(history.next(true)!.before, "before21");
  history.accept(pending, page(11, 20, "before11"));
  const blocks = history.view()!.blocks, index = blocks.findIndex(b => b.id === execution.id);
  assert.equal(blocks[index + 1]!.parent_id, execution.id);
  history.live(page(22, 31, "before22"));
  assert.ok(!history.view()!.blocks.some(b => b.id === execution.id || b.parent_id === execution.id), "Expired live progress must not retain a stale running indicator");
});

function viewport() {
  const state = { scrollTop: 180, scrollHeight: 1200, clientHeight: 300, getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => nodes.map(node => ({ dataset: { scrollKey: node.key }, getBoundingClientRect: () => ({ top: node.top - state.scrollTop, bottom: node.top + 100 - state.scrollTop }) })) };
  const nodes = [{ key: "first", top: 0 }, { key: "reading", top: 150 }, { key: "after", top: 300 }];
  return { state, nodes, container: state as unknown as HTMLElement };
}

test("Prepending preserves the visible message offset even when new messages also grow below it", () => {
  const { state, nodes, container } = viewport();
  preserveTranscriptPosition(container, () => {
    nodes.forEach(node => { node.top += 500; });
    state.scrollHeight += 900; // 500 above, 400 below: a total-height delta would jump by 400.
  }, true);
  assert.equal(state.scrollTop, 680);
  assert.equal(nodes[1]!.top - state.scrollTop, -30);
});

test("Live updates follow the bottom but do not pull a reader away from older messages", () => {
  const { state, container } = viewport();
  preserveTranscriptPosition(container, () => { state.scrollHeight += 300; });
  assert.equal(state.scrollTop, 180);
  state.scrollTop = state.scrollHeight - state.clientHeight;
  preserveTranscriptPosition(container, () => { state.scrollHeight += 300; });
  assert.equal(state.scrollTop, state.scrollHeight, "Browser clamps the assigned scrollHeight to the bottom");
});
