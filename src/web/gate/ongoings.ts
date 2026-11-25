import type { GateOngoingPage } from "../../../plugins/personal/ongoing/browse.ts";
import { byId, element } from "../shared/dom.ts";
import { request, errorMessage } from "../shared/http.ts";

export function mountOngoings(signal: AbortSignal) {
  const previous = byId<HTMLButtonElement>("ongoing-prev"), next = byId<HTMLButtonElement>("ongoing-next");
  const notice = byId("ongoing-notice");
  let page = 1, loading = false, last = "";
  async function refresh(requested = page) {
    if (loading) return;
    loading = true;
    if (requested !== page) previous.disabled = next.disabled = true;
    if (!last) notice.textContent = "正在加载跟进事项…";
    try {
      const result = await request<GateOngoingPage>("/gate/ongoings?page=" + requested, { signal });
      page = result.page;
      const signature = JSON.stringify(result);
      if (signature !== last) {
        byId("ongoings").replaceChildren(...result.items.map(item => {
          const card = element("article", undefined, "work");
          card.append(element("strong", item.title));
          if (item.topicId) {
            const link = element("a", item.topicName || item.topicId);
            link.href = "/?topic=" + encodeURIComponent(item.topicId);
            card.append(link);
          }
          if (item.question) card.append(element("p", "待核实：" + item.question));
          if (item.progress) card.append(element("p", "进展：" + item.progress));
          if (item.checkAt) card.append(element("p", "下次核实：" + new Date(item.checkAt).toLocaleString(), "muted"));
          return card;
        }));
        byId("ongoing-page").textContent = `共 ${result.total} 项 · 第 ${page} / ${result.pages} 页`;
        byId("ongoing-pages").hidden = !result.total;
        last = signature;
      }
      notice.textContent = result.total ? "" : "暂无待跟进事项。";
      previous.disabled = page <= 1; next.disabled = page >= result.pages;
    } catch (error) {
      if (!signal.aborted) notice.textContent = errorMessage(error) + " 正在重试。";
    } finally { loading = false; }
  }
  previous.addEventListener("click", () => void refresh(page - 1), { signal });
  next.addEventListener("click", () => void refresh(page + 1), { signal });
  return { refresh };
}
