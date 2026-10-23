const PAGE_SIZE = 10;

type PersonItem = { isMe?: boolean; metadata: { name: string }; spec: { name: string }; status: { summary: string } };

/**
 * @spec Me stays first on every matching page, outside the ordinary page quota, like the default conversation.
 * @spec Other people with accumulated understanding come first; preserve the directory order within each group.
 */
export function personPage<T extends PersonItem>(items: T[], query: string, requestedPage: number | null, selectedId: string | null) {
  const search = query.trim().toLowerCase();
  const matches = items.filter((person) => person.spec.name.toLowerCase().includes(search));
  const pinned = matches.filter((person) => person.isMe);
  const ordinary = matches.filter((person) => !person.isMe);
  const known = ordinary.filter((person) => person.status.summary.trim());
  const unknown = ordinary.filter((person) => !person.status.summary.trim());
  const ordered = [...known, ...unknown];
  const pages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const selectedPage = Math.floor(Math.max(0, ordered.findIndex((person) => person.metadata.name === selectedId)) / PAGE_SIZE) + 1;
  const page = Math.max(1, Math.min(pages, requestedPage ?? selectedPage));
  return { page, pages, total: matches.length, items: [...pinned, ...ordered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)] };
}
