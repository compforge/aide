const PAGE_SIZE = 10;

/**
 * @spec The default conversation stays first on every page, outside the ordinary page quota.
 * @link docs/channel/web.md
 */
export function conversationPage<T extends { id: string; default?: boolean }>(items: T[], requestedPage: number | null, selectedId: string | null) {
  const pinned = items.filter((item) => item.default);
  const ordinary = items.filter((item) => !item.default);
  const pages = Math.max(1, Math.ceil(ordinary.length / PAGE_SIZE));
  const selectedPage = Math.floor(Math.max(0, ordinary.findIndex((item) => item.id === selectedId)) / PAGE_SIZE) + 1;
  const page = Math.max(1, Math.min(pages, requestedPage ?? selectedPage));
  return { page, pages, items: [...pinned, ...ordinary.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)] };
}
