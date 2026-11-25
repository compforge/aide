import type { GateOngoingPage } from "../../../plugins/personal/ongoing/browse.ts";
import { byId, element, newId } from "../shared/dom.ts";
import { request, errorMessage } from "../shared/http.ts";

export function mountOngoings(signal: AbortSignal) {
  const previous = byId<HTMLButtonElement>("ongoing-prev"), next = byId<HTMLButtonElement>("ongoing-next");
  const notice = byId("ongoing-notice");
  const dialog = byId<HTMLDialogElement>("ongoing-supplement");
  const text = byId<HTMLTextAreaElement>("ongoing-supplement-text");
  const cancel = byId<HTMLButtonElement>("ongoing-supplement-cancel");
  const submit = byId<HTMLButtonElement>("ongoing-supplement-submit");
  const submitNotice = byId("ongoing-supplement-notice");
  const resultNotice = byId("ongoing-supplement-result");
  let page = 1, loading = false, last = "";
  let selectedId = "", sending = false;
  let draft: { text: string; key: string } | undefined;

  cancel.addEventListener("click", () => dialog.close(), { signal });
  dialog.addEventListener("cancel", event => { if (sending) event.preventDefault(); }, { signal });
  byId<HTMLFormElement>("ongoing-supplement-form").addEventListener("submit", async event => {
    event.preventDefault();
    const content = text.value.trim();
    if (!content) {
      submitNotice.textContent = "请输入要补充的信息。";
      text.focus();
      return;
    }
    if (sending) return;
    if (!draft || draft.text !== content) draft = { text: content, key: newId() };
    sending = submit.disabled = cancel.disabled = text.readOnly = true;
    submitNotice.textContent = "正在提交…";
    try {
      await request("/gate/ongoings/supplement", {
        method: "POST", signal, headers: { "content-type": "application/json", "idempotency-key": draft.key },
        body: JSON.stringify({ id: selectedId, text: content }),
      });
      if (signal.aborted) return;
      dialog.close();
      resultNotice.textContent = "已补充";
      void refresh();
    } catch (error) {
      if (!signal.aborted) submitNotice.textContent = errorMessage(error);
    } finally {
      sending = submit.disabled = cancel.disabled = text.readOnly = false;
    }
  }, { signal });

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
          const header = element("div", undefined, "work-header");
          const supplement = element("button", "补充");
          supplement.type = "button";
          supplement.setAttribute("aria-label", "补充 " + item.title);
          supplement.addEventListener("click", () => {
            selectedId = item.id;
            draft = undefined;
            text.value = submitNotice.textContent = resultNotice.textContent = "";
            byId("ongoing-supplement-title").textContent = item.title;
            dialog.showModal();
          }, { signal });
          header.append(element("strong", item.title), supplement);
          card.append(header);
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
