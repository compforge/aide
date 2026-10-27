export interface PageQuery { page?: number; pageSize?: number }

export function pageSize(query: PageQuery) {
  const size = query.pageSize ?? 20;
  if (!Number.isInteger(size) || size < 1 || size > 100 || (query.page !== undefined && (!Number.isSafeInteger(query.page) || query.page < 1)))
    throw new Error("Invalid list page");
  return size;
}
export function pageBounds(total: number, size: number, requested = 1) {
  const pages = Math.max(1, Math.ceil(total / size));
  return { total, pageSize: size, pages, page: Math.min(requested, pages) };
}
