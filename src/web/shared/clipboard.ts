/** Copy also works on HTTP devbox pages, where the Clipboard API is unavailable. */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard) { await navigator.clipboard.writeText(text); return; }
  } catch { /* Fall back to the selection-based copy supported on HTTP pages. */ }
  const active = document.activeElement;
  const selection = document.createElement("textarea");
  selection.value = text; selection.readOnly = true;
  selection.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(selection);
  try {
    selection.focus({ preventScroll: true }); selection.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard copy failed");
  } finally {
    selection.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
  }
}
