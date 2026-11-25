import { byId, newId } from "../shared/dom.ts";
import { request, errorMessage } from "../shared/http.ts";

export function mountSupplement(signal: AbortSignal, refresh: () => void) {
  const dialog = byId<HTMLDialogElement>("ongoing-supplement");
  const text = byId<HTMLTextAreaElement>("ongoing-supplement-text");
  const cancel = byId<HTMLButtonElement>("ongoing-supplement-cancel");
  const submit = byId<HTMLButtonElement>("ongoing-supplement-submit");
  const submitNotice = byId("ongoing-supplement-notice");
  const resultNotice = byId("ongoing-supplement-result");
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
      refresh();
    } catch (error) {
      if (!signal.aborted) submitNotice.textContent = errorMessage(error);
    } finally {
      sending = submit.disabled = cancel.disabled = text.readOnly = false;
    }
  }, { signal });

  return function openSupplement(id: string, title: string) {
    selectedId = id;
    draft = undefined;
    text.value = submitNotice.textContent = resultNotice.textContent = "";
    byId("ongoing-supplement-title").textContent = title;
    dialog.showModal();
  };
}
