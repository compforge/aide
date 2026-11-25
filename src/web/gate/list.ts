import { byId } from "../shared/dom.ts";
import { errorMessage, request } from "../shared/http.ts";

interface Page<T> { items: T[]; total: number; page: number; pages: number }

export function mountGateList<T>(key: "notes" | "work", signal: AbortSignal, render: (item: T) => HTMLElement) {
  const list = byId(key + "-list"), pages = byId(key + "-pages"), notice = byId(key + "-notice");
  const filters = [...byId("panel-" + key).querySelectorAll("select")];
  const previous = byId<HTMLButtonElement>(key + "-prev"), next = byId<HTMLButtonElement>(key + "-next");
  let page = 1, last = "", pending: string | undefined;
  let generation = 0;

  async function refresh(target = page) {
    const params = new URLSearchParams({ page: String(target) });
    for (const filter of filters) if (filter.value) params.set(filter.name, filter.value);
    const url = "/gate/" + key + "?" + params;
    if (url === pending) return;
    const current = ++generation;
    pending = url;
    if (!last) notice.textContent = "加载中…";
    try {
      const result = await request<Page<T>>(url, { signal });
      if (signal.aborted || current !== generation) return;
      page = result.page;
      const signature = JSON.stringify(result);
      if (signature !== last) {
        list.replaceChildren(...result.items.map(render));
        byId(key + "-page").textContent = `共 ${result.total} 项 · 第 ${page} / ${result.pages} 页`;
        last = signature;
      }
      pages.hidden = !result.total;
      previous.disabled = page <= 1;
      next.disabled = page >= result.pages;
      notice.textContent = result.total ? "" : key === "notes" ? "没有符合条件的 Note。" : "没有符合条件的 Work。";
    } catch (error) {
      if (current === generation && !signal.aborted) notice.textContent = errorMessage(error) + " 正在重试。";
    } finally { if (current === generation) pending = undefined; }
  }
  function navigate(target: number) {
    page = target;
    previous.disabled = next.disabled = true;
    void refresh();
  }
  for (const filter of filters) filter.addEventListener("change", () => {
    list.replaceChildren(); last = ""; pages.hidden = true;
    navigate(1);
  }, { signal });
  previous.addEventListener("click", () => navigate(page - 1), { signal });
  next.addEventListener("click", () => navigate(page + 1), { signal });
  return { refresh };
}
