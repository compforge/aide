import assert from "node:assert/strict";
import { test } from "node:test";
import { topicPage, topicTree } from "../src/web/topics/pagination.ts";

test("Topic pages keep the default first without skipping or repeating ordinary topics", () => {
  const ordinary = Array.from({ length: 21 }, (_, index) => ({ id: String(index), default: false }));
  const pinned = { id: "default", default: true };
  const items = [...ordinary.slice(0, 5), pinned, ...ordinary.slice(5)];
  const pages = [1, 2, 3].map((page) => topicPage(items, page, null));
  assert.deepEqual(pages.map((page) => page.items.length), [11, 11, 2]);
  assert.ok(pages.every((page) => page.items[0] === pinned && page.pages === 3));
  assert.deepEqual(pages.flatMap((page) => page.items.slice(1)), ordinary);
  assert.equal(topicPage(items, null, "15").page, 2);
  assert.equal(topicPage(items, 3, "15").page, 3, "explicit page wins over selected topic");
  assert.equal(topicPage(items, null, pinned.id).page, 1);
});

test("Topic pages handle deletion, an empty list and changing the default", () => {
  assert.deepEqual(topicPage([], 8, null), { page: 1, pages: 1, requestedPage: 1, items: [] });
  const items = Array.from({ length: 11 }, (_, index) => ({ id: String(index), default: false }));
  assert.equal(topicPage(items, 2, null).items[0]?.id, "10");
  assert.equal(topicPage(items.slice(0, 10), 2, null).page, 1);
  const promoted = items.map((item) => ({ ...item, default: item.id === "10" }));
  const page = topicPage(promoted, 2, null);
  assert.equal(page.page, 1);
  assert.equal(page.items[0]?.id, "10");
  assert.equal(new Set(page.items.map((item) => item.id)).size, 11);
  assert.equal(topicPage(items, 2, null).items[0]?.id, "10", "unsetting default returns it to ordinary pagination");
});

test("A new topic stays visible after persistence reorders it, while manual browsing stays on its page", () => {
  const existing = Array.from({ length: 21 }, (_, index) => ({ id: String(index) }));
  const selected = { id: "new-chat" };
  const draft = topicPage([...existing, selected], null, selected.id);
  assert.equal(draft.page, 3);
  assert.equal(draft.requestedPage, null, "automatic page selection must not become an explicit request");
  const saved = topicPage([selected, ...existing], draft.requestedPage, selected.id);
  assert.equal(saved.page, 1);
  assert.ok(saved.items.includes(selected));
  assert.equal(saved.requestedPage, null);

  const browsing = topicPage([...existing, selected], 2, selected.id);
  const refreshed = topicPage([selected, ...existing], browsing.requestedPage, selected.id);
  assert.equal(refreshed.page, 2);
  assert.equal(refreshed.requestedPage, 2);
  assert.equal(refreshed.items.includes(selected), false, "explicit browsing should not jump back to the active topic");
});


test("Topic tree defaults to roots and expands descendants without duplicating them", () => {
  const nodes = [{ uid: "root" }, { uid: "child", parentUid: "root" }, { uid: "grandchild", parentUid: "child" }, { uid: "other" }];
  assert.deepEqual(topicTree(nodes, new Set()).map(t => t.item.uid), ["root", "other"]);
  assert.deepEqual(topicTree(nodes, new Set(["root", "child"])).map(t => [t.item.uid, t.depth]), [["root", 0], ["child", 1], ["grandchild", 2], ["other", 0]]);
});
