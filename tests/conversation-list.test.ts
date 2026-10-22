import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationPage } from "../src/web/conversation-list.ts";

test("Conversation pages keep the default first without skipping or repeating ordinary conversations", () => {
  const ordinary = Array.from({ length: 21 }, (_, index) => ({ id: String(index), default: false }));
  const pinned = { id: "default", default: true };
  const items = [...ordinary.slice(0, 5), pinned, ...ordinary.slice(5)];
  const pages = [1, 2, 3].map((page) => conversationPage(items, page, null));
  assert.deepEqual(pages.map((page) => page.items.length), [11, 11, 2]);
  assert.ok(pages.every((page) => page.items[0] === pinned && page.pages === 3));
  assert.deepEqual(pages.flatMap((page) => page.items.slice(1)), ordinary);
  assert.equal(conversationPage(items, null, "15").page, 2);
  assert.equal(conversationPage(items, 3, "15").page, 3, "explicit page wins over selected conversation");
  assert.equal(conversationPage(items, null, pinned.id).page, 1);
});

test("Conversation pages handle deletion, an empty list and changing the default", () => {
  assert.deepEqual(conversationPage([], 8, null), { page: 1, pages: 1, items: [] });
  const items = Array.from({ length: 11 }, (_, index) => ({ id: String(index), default: false }));
  assert.equal(conversationPage(items, 2, null).items[0]?.id, "10");
  assert.equal(conversationPage(items.slice(0, 10), 2, null).page, 1);
  const promoted = items.map((item) => ({ ...item, default: item.id === "10" }));
  const page = conversationPage(promoted, 2, null);
  assert.equal(page.page, 1);
  assert.equal(page.items[0]?.id, "10");
  assert.equal(new Set(page.items.map((item) => item.id)).size, 11);
  assert.equal(conversationPage(items, 2, null).items[0]?.id, "10", "unsetting default returns it to ordinary pagination");
});
