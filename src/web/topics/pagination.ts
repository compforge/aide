const PAGE_SIZE = 10;

/**
 * @spec The default topic stays first on every page, outside the ordinary page quota.
 * @spec Automatic selection follows the active topic across refreshes; only explicit page requests retain a page.
 * @link docs/channel/web.md
 */
export function topicPage<T extends { id: string; default?: boolean }>(items: T[], requestedPage: number | null, selectedId: string | null) {
  const pinned = items.filter((item) => item.default);
  const ordinary = items.filter((item) => !item.default);
  const pages = Math.max(1, Math.ceil(ordinary.length / PAGE_SIZE));
  const selectedPage = Math.floor(Math.max(0, ordinary.findIndex((item) => item.id === selectedId)) / PAGE_SIZE) + 1;
  const page = Math.max(1, Math.min(pages, requestedPage ?? selectedPage));
  return { page, pages, requestedPage: requestedPage === null ? null : page,
    items: [...pinned, ...ordinary.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)] };
}

/** Parent-only storage becomes a finite preorder projection; hidden descendants do not consume sidebar pages. */
export function topicTree<T extends { uid: string | null; parentUid?: string }>(items: T[], expanded: ReadonlySet<string>) {
  const children = new Map<string | undefined, T[]>();
  const known = new Set(items.map(t => t.uid));
  for (const item of items) {
    const parent = item.parentUid && known.has(item.parentUid) ? item.parentUid : undefined;
    children.set(parent, [...children.get(parent) ?? [], item]);
  }
  const rows: { item: T; depth: number }[] = [], visited = new Set<T>();
  const visit = (item: T, depth: number) => {
    if (visited.has(item)) return;
    visited.add(item); rows.push({ item, depth });
    if (item.uid && expanded.has(item.uid)) for (const child of children.get(item.uid) ?? []) visit(child, depth + 1);
  };
  for (const item of children.get(undefined) ?? []) visit(item, 0);
  return rows;
}
