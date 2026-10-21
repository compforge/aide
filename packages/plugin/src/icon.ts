/**
 * @spec The same category always receives the same icon across processes and restarts.
 * @rule Keep this catalog's order, length and hash fixed: changing them would reassign existing identities.
 * @why Icons distinguish categories without maintaining a provider-to-artwork mapping; labels disambiguate collisions.
 */
const ICONS = [
  "M3 4h18v16H3zM3 8h18M7 12h10M7 16h6",
  "m3 4 18 8-18 8 4-8zM7 12h14",
  "M3 3h18v7H3zM3 14h18v7H3zM7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5",
  "M8 4H4v17h16V4h-4M8 2h8v5H8zM8 12h8M8 16h5",
  "m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3z",
  "M4 7h16M8 7v13M16 7v10q0 3 4 3M4 7q0-3 3-3",
  "M5 4h14q3 0 3 3v10q0 3-3 3H5q-3 0-3-3V7q0-3 3-3zM7 9l3 3-3 3M13 15h4",
  "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M5.6 18.4 18.4 5.6",
  "m12 3 9 9-9 9-9-9zM8 12h8m-4-4v8",
  "M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5ZM8 11h8M8 15h5",
  "M6 16.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM5 10a9 9 0 0 1 9 9M5 4a15 15 0 0 1 15 15",
  "m8 4-5 8 5 8m8-16 5 8-5 8M14 4l-4 16",
  "M12 3 3 8l9 5 9-5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5",
  "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l4 2",
  "M4 18h16M6 18V9h4v9M14 18V4h4v14",
] as const;

/** SVG path data in a 24 x 24 viewBox, hashed from a namespaced category ID. */
export function iconFor(category: string): string {
  let hash = 2166136261;
  for (let i = 0; i < category.length; i++) hash = Math.imul(hash ^ category.charCodeAt(i), 16777619);
  return ICONS[(hash >>> 0) % ICONS.length]!;
}
