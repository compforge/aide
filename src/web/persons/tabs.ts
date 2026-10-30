import { byId } from '../shared/dom.ts';

/** @spec Tabs keep mounted drafts; arrow keys, Home and End move selection and focus together. */
export function mountPersonTabs(onNotes: () => void) {
  const buttons = [...byId('person-tabs').querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  let selected = 0;
  function select(index: number) {
    selected = index;
    buttons.forEach((button, i) => {
      button.setAttribute('aria-selected', String(i === index));
      button.tabIndex = i === index ? 0 : -1;
      byId(button.getAttribute('aria-controls')!).hidden = i !== index;
    });
    if (index === 1) onNotes();
  }
  buttons.forEach((button, index) => {
    button.onclick = () => select(index);
    button.onkeydown = (event) => {
      const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length
        : event.key === 'ArrowLeft' ? (index + buttons.length - 1) % buttons.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); select(next); buttons[next]!.focus();
    };
  });
  return { reset: () => select(0), refresh: () => { if (selected === 1) onNotes(); } };
}
