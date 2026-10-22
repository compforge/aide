const PAGE_SIZE = 10;

type PersonItem = { metadata: { name: string }; spec: { name: string; profile: { understanding: string } } };

// @spec People with accumulated understanding come first; preserve the directory order within each group.
export function personPage<T extends PersonItem>(items: T[], query: string, requestedPage: number | null, selectedId: string | null) {
  const search = query.trim().toLowerCase();
  const matches = items.filter((person) => person.spec.name.toLowerCase().includes(search));
  const known = matches.filter((person) => person.spec.profile.understanding.trim());
  const unknown = matches.filter((person) => !person.spec.profile.understanding.trim());
  const ordered = [...known, ...unknown];
  const pages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const selectedPage = Math.floor(Math.max(0, ordered.findIndex((person) => person.metadata.name === selectedId)) / PAGE_SIZE) + 1;
  const page = Math.max(1, Math.min(pages, requestedPage ?? selectedPage));
  return { page, pages, total: ordered.length, items: ordered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) };
}
