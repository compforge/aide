import { byId } from "../shared/dom.ts";

/**
 * @spec Tabs keep mounted content, drafts and independent reading positions within the selected topic.
 * @why A hidden timeline has no layout; defer its rendering until it is visible to preserve scroll-follow intent.
 * @see {@link component://docs/channel/web.md}
 */
export function mountTopicTabs(enabled: boolean, signal: AbortSignal, onDialogue: () => void, onTree: () => void) {
  const buttons = [...byId("topic-tabs").querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = buttons.map((button) => byId(button.getAttribute("aria-controls")!));
  const scrollers = panels.map((panel, index) => index === 0 ? byId("messages") : panel);
  const positions = panels.map(() => 0);
  let selected = 0;
  byId("topic-tabs").hidden = !enabled;
  function display() {
    buttons.forEach((button, index) => {
      button.setAttribute("aria-selected", String(index === selected));
      button.tabIndex = index === selected ? 0 : -1;
      panels[index]!.hidden = index !== selected;
    });
  }
  function select(index: number) {
    if (index === selected) return;
    positions[selected] = scrollers[selected]!.scrollTop;
    selected = index;
    display();
    scrollers[selected]!.scrollTop = positions[selected]!;
    if (selected === 0) onDialogue();
    if (buttons[selected]!.id === "tab-tree") onTree();
  }
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => select(index), { signal });
    button.addEventListener("keydown", (event) => {
      const next = event.key === "ArrowRight" ? (index + 1) % buttons.length
        : event.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length
        : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
      if (next === null) return;
      event.preventDefault();
      select(next);
      buttons[next]!.focus();
    }, { signal });
  });
  display();
  scrollers.forEach((scroller) => { scroller.scrollTop = 0; });
  return { isDialogue: () => selected === 0 };
}
