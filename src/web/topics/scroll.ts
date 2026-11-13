/**
 * @spec Prepending history preserves the visible message and its offset; new content follows only readers already at the bottom.
 * @why Height deltas alone mix older inserts with simultaneous live growth below the viewport.
 */
export function preserveTranscriptPosition(container: HTMLElement, update: () => void, preserve = false) {
  const top = container.scrollTop;
  const follow = !preserve && container.scrollHeight - top - container.clientHeight < 100;
  const edge = container.getBoundingClientRect().top;
  const anchor = [...container.querySelectorAll<HTMLElement>("[data-scroll-key]")].find(node => node.getBoundingClientRect().bottom > edge);
  const key = anchor?.dataset.scrollKey, offset = anchor?.getBoundingClientRect().top;
  update();
  if (follow) { container.scrollTop = container.scrollHeight; return; }
  const retained = key && [...container.querySelectorAll<HTMLElement>("[data-scroll-key]")].find(node => node.dataset.scrollKey === key);
  container.scrollTop = retained && offset !== undefined ? container.scrollTop + retained.getBoundingClientRect().top - offset : top;
}
