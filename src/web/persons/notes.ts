import { renderNoteClassification } from "../shared/note-classification.ts";
import type { PersonView, PersonNotesView } from '../../api/types.ts';
import { byId as $, element } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import { updateMarkdown } from '../shared/markdown.ts';

/** @spec Person records come from Note.people; switching people cancels stale pages without touching profile drafts. */
export class PersonNotes {
  private person?: PersonView;
  private controller?: AbortController;
  private page = 1;
  private pages = 1;
  private requestedPage = 1;
  private loaded = false;
  constructor() {
    $('person-notes-refresh').onclick = () => void this.load(this.requestedPage);
    $('person-notes-previous').onclick = () => void this.load(this.page - 1);
    $('person-notes-next').onclick = () => void this.load(this.page + 1);
  }
  pause() {
    if (this.controller) $('person-notes-notice').textContent = '';
    this.controller?.abort(); this.controller = undefined;
    this.updateButtons();
  }
  reset(person: PersonView) {
    this.pause(); this.person = person; this.page = this.pages = this.requestedPage = 1; this.loaded = false;
    $('person-notes').replaceChildren(); $('person-notes-notice').textContent = '';
    $('person-note-pages').hidden = true;
  }
  show() { if (!this.loaded && !this.controller) void this.load(this.requestedPage); }
  private updateButtons() {
    $<HTMLButtonElement>('person-notes-refresh').disabled = !!this.controller;
    $<HTMLButtonElement>('person-notes-previous').disabled = !!this.controller || this.page <= 1;
    $<HTMLButtonElement>('person-notes-next').disabled = !!this.controller || this.page >= this.pages;
  }
  /** @spec Failed navigation keeps the displayed page and retries the requested page; reset or pause rejects late responses. */
  private async load(number: number) {
    if (!this.person) return;
    this.pause();
    const controller = new AbortController(); this.controller = controller; this.requestedPage = number; this.updateButtons();
    const query = new URLSearchParams({ id: this.person.metadata.name, uid: this.person.metadata.uid, page: String(number), pageSize: "5" });
    $('person-notes-notice').textContent = '正在加载…';
    try {
      const page = await request<PersonNotesView>('/persons/notes?' + query, { signal: controller.signal });
      if (controller.signal.aborted) return;
      $('person-notes').replaceChildren();
      for (const note of page.items) {
        const item = element('article', undefined, 'person-note');
        const time = element('time', new Date(note.updatedAt).toLocaleString(), 'muted'); time.dateTime = note.updatedAt;
        const content = element('div', undefined, 'markdown'); updateMarkdown(content, note.text);
        item.append(time, content); renderNoteClassification(item, note); $('person-notes').append(item);
      }
      this.loaded = true; this.page = this.requestedPage = page.page; this.pages = page.pages;
      $('person-note-pages').hidden = false;
      $('person-notes-page').textContent = `共 ${page.total} 条 · 第 ${page.page} / ${page.pages} 页`;
      $('person-notes-notice').textContent = page.items.length ? '' : '暂无相关记录。';
    } catch (error) {
      if (!controller.signal.aborted) $('person-notes-notice').textContent = errorMessage(error);
    } finally {
      if (this.controller === controller) { this.controller = undefined; this.updateButtons(); }
    }
  }
}
