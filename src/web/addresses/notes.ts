import type { AddressRef } from "../../../plugins/personal/address/model.ts";
import { renderNoteClassification } from "../shared/note-classification.ts";
import type { AddressNotesView } from '../../api/types.ts';
import { byId as $, element } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import { updateMarkdown } from '../shared/markdown.ts';

/** @spec Address records come from Note.addresses; switching addresses cancels stale pages without touching summary drafts. */
export class AddressNotes {
  private address?: AddressRef;
  private controller?: AbortController;
  private page = 1;
  private pages = 1;
  private requestedPage = 1;
  private loaded = false;
  constructor() {
    $('notes-refresh').onclick = () => void this.load(this.requestedPage);
    $('notes-previous').onclick = () => void this.load(this.page - 1);
    $('notes-next').onclick = () => void this.load(this.page + 1);
  }
  pause() {
    if (this.controller) $('notes-notice').textContent = '';
    this.controller?.abort(); this.controller = undefined;
    this.updateButtons();
  }
  reset(address: AddressRef) {
    this.pause(); this.address = address; this.page = this.pages = this.requestedPage = 1; this.loaded = false;
    $('notes').replaceChildren(); $('notes-notice').textContent = '';
    $('note-pages').hidden = true;
  }
  show() { if (!this.loaded && !this.controller) void this.load(this.requestedPage); }
  private updateButtons() {
    $<HTMLButtonElement>('notes-refresh').disabled = !!this.controller;
    $<HTMLButtonElement>('notes-previous').disabled = !!this.controller || this.page <= 1;
    $<HTMLButtonElement>('notes-next').disabled = !!this.controller || this.page >= this.pages;
  }
  /** @spec Failed navigation keeps the displayed page and retries the requested page; reset or pause rejects late responses. */
  private async load(number: number) {
    if (!this.address) return;
    this.pause();
    const controller = new AbortController(); this.controller = controller; this.requestedPage = number; this.updateButtons();
    const query = new URLSearchParams({ name: this.address.name, uid: this.address.uid, page: String(number), pageSize: "5" });
    $('notes-notice').textContent = '正在加载…';
    try {
      const page = await request<AddressNotesView>('/addresses/notes?' + query, { signal: controller.signal });
      if (controller.signal.aborted) return;
      $('notes').replaceChildren();
      for (const note of page.items) {
        const item = element('article', undefined, 'address-note');
        const time = element('time', new Date(note.updatedAt).toLocaleString(), 'muted'); time.dateTime = note.updatedAt;
        const content = element('div', undefined, 'markdown'); updateMarkdown(content, note.text);
        item.append(element("h3", (note.nameMissing ? "[未命名] " : "") + (note.name ?? "未命名笔记")), time, content); renderNoteClassification(item, note); $('notes').append(item);
      }
      this.loaded = true; this.page = this.requestedPage = page.page; this.pages = page.pages;
      $('note-pages').hidden = false;
      $('notes-page').textContent = `共 ${page.total} 条 · 第 ${page.page} / ${page.pages} 页`;
      $('notes-notice').textContent = page.items.length ? '' : '暂无相关记录。';
    } catch (error) {
      if (!controller.signal.aborted) $('notes-notice').textContent = errorMessage(error);
    } finally {
      if (this.controller === controller) { this.controller = undefined; this.updateButtons(); }
    }
  }
}
