import assert from "node:assert/strict";
import { test } from "node:test";
import { personPage } from "../src/web/persons/pagination.ts";

function person(id: string, understanding = "", name = id) {
  return { metadata: { name: id }, spec: { name, profile: { understanding } } };
}

test("Person pages put understanding first and preserve order within both groups without mutating the directory", () => {
  const items = Array.from({ length: 23 }, (_, index) => person(String(index), index % 3 === 0 ? "Known" : ""));
  const original = [...items];
  const pages = [1, 2, 3].map((page) => personPage(items, "", page, null));
  assert.deepEqual(pages.map((page) => page.items.length), [10, 10, 3]);
  assert.ok(pages.every((page) => page.pages === 3 && page.total === 23));
  assert.deepEqual(pages.flatMap((page) => page.items), [...items.filter((p) => p.spec.profile.understanding), ...items.filter((p) => !p.spec.profile.understanding)]);
  assert.deepEqual(items, original);
  assert.deepEqual(personPage([person("blank", " \n "), person("known", "Text")], "", 1, null).items.map((p) => p.metadata.name), ["known", "blank"]);
});

test("Person search filters before pagination and orders matching people by understanding", () => {
  const items = [person("other", "Known", "Other"), ...Array.from({ length: 11 }, (_, i) => person(String(i), i === 10 ? "Known" : "", `Alice ${i}`))];
  const first = personPage(items, " ALICE ", 1, null);
  assert.equal(first.total, 11);
  assert.equal(first.pages, 2);
  assert.equal(first.items[0]?.metadata.name, "10");
  assert.deepEqual(personPage(items, "alice", 2, null).items.map((p) => p.metadata.name), ["9"]);
  assert.deepEqual(personPage(items, "nobody", 4, null), { page: 1, pages: 1, total: 0, items: [] });
});

test("Person pagination follows the initial selection while explicit browsing retains its page", () => {
  const items = Array.from({ length: 21 }, (_, i) => person(String(i)));
  assert.equal(personPage(items, "", null, "20").page, 3);
  assert.equal(personPage(items, "", 2, "20").page, 2);
  const profiled = items.map((p) => p.metadata.name === "20" ? person("20", "New understanding") : p);
  assert.equal(personPage(profiled, "", null, "20").page, 1);
  assert.equal(personPage(profiled, "", 2, "20").page, 2);
  assert.equal(personPage(items.slice(0, 10), "", 3, null).page, 1);
  assert.deepEqual(personPage([], "", null, null), { page: 1, pages: 1, total: 0, items: [] });
});

test("Me stays first on every page outside the ordinary quota, even without understanding", () => {
  const ordinary = Array.from({ length: 21 }, (_, index) => person(String(index), index % 3 === 0 ? "Known" : ""));
  const me = { ...person("me"), isMe: true };
  const items = [...ordinary.slice(0, 12), me, ...ordinary.slice(12)];
  const pages = [1, 2, 3].map((page) => personPage(items, "", page, null));
  assert.deepEqual(pages.map((page) => page.items.length), [11, 11, 2]);
  assert.ok(pages.every((page) => page.items[0] === me && page.pages === 3 && page.total === 22));
  assert.deepEqual(pages.flatMap((page) => page.items.slice(1)), [
    ...ordinary.filter((p) => p.spec.profile.understanding), ...ordinary.filter((p) => !p.spec.profile.understanding),
  ]);
  assert.equal(personPage(items, "", null, me.metadata.name).page, 1);
  assert.equal(personPage(items, "", 2, me.metadata.name).page, 2);
  assert.deepEqual(personPage([me], "", 8, null), { page: 1, pages: 1, total: 1, items: [me] });
});

test("Me pinning respects search and adjusts pages when the identity mark changes", () => {
  const ordinary = Array.from({ length: 10 }, (_, index) => person(String(index), "", `Alice ${index}`));
  const me = { ...person("me", "", "Alice Me"), isMe: true };
  const items = [...ordinary, me];
  assert.equal(personPage(items, "ALICE", 2, null).page, 1, "Me must not create an extra page");
  assert.equal(personPage(items, "ALICE", 1, null).items[0], me);
  assert.deepEqual(personPage(items, "Alice 9", 1, null).items, [ordinary[9]]);
  assert.deepEqual(personPage(items, "nobody", 2, null), { page: 1, pages: 1, total: 0, items: [] });
  const unmarked = items.map((p) => ({ ...p, isMe: false }));
  assert.equal(personPage(unmarked, "", 2, null).items[0]?.metadata.name, "me");
  assert.equal(personPage(unmarked, "", 2, null).pages, 2);
});
