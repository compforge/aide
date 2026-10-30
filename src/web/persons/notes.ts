import type { PersonView, PersonNotesView } from '../../api/types.ts';
import { byId as $, element } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import { updateMarkdown } from '../shared/markdown.ts';

/** @spec Person records come from Note.people; switching people cancels stale pages without touching profile drafts. */
export class PersonNotes {
  private person?: PersonView;
  private controller?: AbortController;
  private continuation?: string;
  private loaded = false;
  constructor() {
    $('person-notes-refresh').onclick = () => void this.load(true);
    $('person-notes-more').onclick = () => void this.load(false);
  }
  pause() {
    if (this.controller) $('person-notes-notice').textContent = '';
    this.controller?.abort(); this.controller = undefined;
    $<HTMLButtonElement>('person-notes-more').disabled = false;
  }
  reset(person: PersonView) {
    this.pause(); this.person = person; this.continuation = undefined; this.loaded = false;
    $('person-notes').replaceChildren(); $('person-notes-notice').textContent = '';
    $('person-notes-more').hidden = true;
  }
  show() { if (!this.loaded && !this.controller) void this.load(true); }
  private async load(reset: boolean) {
    if (!this.person) return;
    this.pause();
    const controller = new AbortController(); this.controller = controller;
    const query = new URLSearchParams({ id: this.person.metadata.name, uid: this.person.metadata.uid });
    if (!reset && this.continuation) query.set('continue', this.continuation);
    const more = $<HTMLButtonElement>('person-notes-more');
    more.disabled = true;
    $('person-notes-notice').textContent = '正在加载…';
    try {
      const page = await request<PersonNotesView>('/persons/notes?' + query, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (reset) $('person-notes').replaceChildren();
      for (const note of page.items) {
        const item = element('article', undefined, 'person-note');
        const time = element('time', new Date(note.updatedAt).toLocaleString(), 'muted'); time.dateTime = note.updatedAt;
        const content = element('div', undefined, 'markdown'); updateMarkdown(content, note.text);
        item.append(time, content); $('person-notes').append(item);
      }
      this.loaded = true; this.continuation = page.continue;
      more.hidden = !page.continue;
      $('person-notes-notice').textContent = $('person-notes').childElementCount ? (page.continue ? '' : '已显示全部相关记录。') : '暂无相关记录。';
    } catch (error) {
      if (!controller.signal.aborted) $('person-notes-notice').textContent = errorMessage(error);
    } finally {
      if (this.controller === controller) { this.controller = undefined; more.disabled = false; }
    }
  }
}
