import { renderNoteClassification } from "../shared/note-classification.ts";
import type { ChannelSettingsView } from "../../channel/settings.ts";
import './style.css';
import { byId as $, element as node } from '../shared/dom.ts';
import { request, errorMessage, HttpError } from '../shared/http.ts';
import { updateMarkdown } from '../shared/markdown.ts';
import type { Addresses } from '../../../plugins/personal/address/service.ts';
import type { AddressListView } from '../../../plugins/personal/address/browse.ts';
import type { AddressRef } from '../../../plugins/personal/address/model.ts';
import type { Note } from '../../../plugins/personal/note/model.ts';
type View = ReturnType<Addresses['view']>;
type Page = AddressListView;
type Item = Page['items'][number];
const items = new Map<string, Item>();
let selected: View | undefined, noteContinue: string | undefined;
let page: Page | undefined, currentPage: number | undefined, listLoading = false;
let settings: ChannelSettingsView | undefined;
async function loadSettings() {
  try { settings = await request<ChannelSettingsView>("/channels/config"); } catch { settings = undefined; }
  renderList();
}
let notesLoading = false;
let busy = false, generation = 0, listGeneration = 0;
const types = { group: '群聊', direct: '私聊', web: 'Web', external: '外部系统' };
function currentRef(): AddressRef {
  if (!selected) throw new Error('请先选择地址');
  return { apiVersion: 'aide.dev/v1alpha1', kind: 'Address', namespace: 'v1', name: selected.metadata.name, uid: selected.metadata.uid };
}
function parameters(ref: AddressRef) { return new URLSearchParams({ name: ref.name, uid: ref.uid }); }
function saveLocation() {
  const url = new URL(location.href);
  if (selected) { url.searchParams.set('name', selected.metadata.name); url.searchParams.set('uid', selected.metadata.uid); }
  if (currentPage !== undefined) url.searchParams.set('page', String(currentPage));
  history.replaceState(null, '', url);
}
function report(error: unknown) { $('notice').textContent = errorMessage(error); }
function render(value: View) {
  selected = value; $('detail').hidden = false;
  $('heading').textContent = value.spec.name;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('#list a')) link.setAttribute('aria-current', String(new URL(link.href).searchParams.get('uid') === value.metadata.uid));
  $('coordinates').textContent = types[value.spec.type];
  updateMarkdown($('summary'), value.summaryText || '尚未积累长期认识。');
  renderNoteClassification($('summary'), value.summaryNote);
  $('people').replaceChildren(...value.participants.map(person => {
    const a = node('a', person.name + (person.clearance ? ` · ${person.clearance}` : ''));
    a.href = '/people?' + new URLSearchParams({ person: person.ref.name, uid: person.ref.uid }); return a;
  }));
}
function appendNotes(items: Note[]) {
  for (const note of items) {
    const card = node('article'), content = node('div', undefined, 'markdown');
    updateMarkdown(content, note.text); card.append(content, node('small', new Date(note.updatedAt).toLocaleString(), 'muted')); renderNoteClassification(card, note); $('notes').append(card);
  }
}
async function loadNotes(reset = false) {
  if (notesLoading && !reset) return;
  notesLoading = true;
  const ref = currentRef(), turn = generation;
  const query = parameters(ref); if (!reset && noteContinue) query.set('continue', noteContinue);
  let result: { items: Note[]; continue?: string };
  try { result = await request('/addresses/notes?' + query); }
  catch (error) {
    if (turn !== generation) return;
    if (!reset && error instanceof HttpError && [400, 410].includes(error.status)) { await loadNotes(true); return; }
    throw error;
  } finally { if (turn === generation) notesLoading = false; }
  if (turn !== generation) return;
  if (reset) $('notes').replaceChildren();
  appendNotes(result.items); noteContinue = result.continue; $('notes-more').hidden = !noteContinue;
}
async function select(ref: AddressRef) {
  if (busy) return;
  if (!$('editor').hidden && !confirm('放弃尚未保存的修改？')) return;
  menu.hidePopover();
  const turn = ++generation;
  const value = await request<View>('/addresses/detail?' + parameters(ref));
  if (turn !== generation) return;
  $('notice').textContent = ''; $('editor').hidden = true; $('summary').hidden = false; render(value);
  saveLocation();
  await loadNotes(true);
}
/** @spec Paging replaces only the sidebar, preserving selected detail and unsaved summary edits. */
async function list(requestedPage = currentPage) {
  const turn = ++listGeneration;
  const query = new URLSearchParams({ pageSize: '10' });
  if (requestedPage !== undefined) query.set('page', String(requestedPage));
  const uid = selected?.metadata.uid ?? new URL(location.href).searchParams.get('uid');
  if (uid) query.set('selectedUid', uid);
  listLoading = true; setBusy(busy);
  try {
    const result = await request<Page>('/addresses/list?' + query);
    if (turn !== listGeneration) return;
    const changed = currentPage !== result.page;
    page = result; currentPage = result.page;
    items.clear();
    for (const item of [...result.pinned, ...result.items]) items.set(item.ref.uid, item);
    renderList(); saveLocation();
    if (changed) $('list').parentElement!.scrollTop = 0;
    $('list-notice').textContent = items.size ? '' : '暂无地址。';
  } catch (error) {
    if (turn === listGeneration) $('list-notice').textContent = errorMessage(error);
  } finally {
    if (turn === listGeneration) { listLoading = false; setBusy(busy); }
  }
}
function renderPagination() {
  $('address-pagination').hidden = !page || page.pages <= 1;
  $('address-page').textContent = page ? `${page.page} / ${page.pages}` : '';
  $<HTMLButtonElement>('address-previous').disabled = busy || listLoading || !page || page.page <= 1;
  $<HTMLButtonElement>('address-next').disabled = busy || listLoading || !page || page.page >= page.pages;
}
async function save(path: string, value: object) {
  setBusy(true); $<HTMLButtonElement>('save').disabled = true;
  try {
    const updated = await request<View>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: currentRef(), ...value }) });
    render(updated); $('notice').textContent = '已保存'; await list(); return true;
  } catch (error) { report(error); return false; }
  finally { setBusy(false); $<HTMLButtonElement>('save').disabled = false; }
}
const menu = node('div', undefined, 'address-menu');
menu.id = 'address-menu'; menu.popover = 'auto';
menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '地址操作');
document.body.append(menu);
let menuButton: HTMLButtonElement | undefined;
menu.addEventListener('toggle', event => { if (event.newState === 'closed') menuButton?.setAttribute('aria-expanded', 'false'); });
menu.addEventListener('keydown', event => {
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const index = buttons.findIndex(button => button === document.activeElement);
  if (event.key === 'Escape') { menu.hidePopover(); menuButton?.focus(); return; }
  const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
    : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
  if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
});
$('list').parentElement!.addEventListener('scroll', () => menu.hidePopover());
window.addEventListener('resize', () => menu.hidePopover());
function setBusy(value: boolean) {
  busy = value;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.address-more, #refresh')) button.disabled = value || listLoading;
  renderPagination();
}
function statusIcon(label: string, drawing: string) {
  const icon = node('span', undefined, 'address-status-icon');
  icon.title = label; icon.setAttribute('aria-label', label); icon.setAttribute('role', 'img');
  icon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + drawing + '</svg>';
  return icon;
}
function renderList() {
  menu.hidePopover();
  const ordered = [...items.values()];
  const defaultUid = page?.pinned[0]?.ref.uid;
  $('list').replaceChildren(...ordered.map(item => {
    const row = node('div', undefined, 'address-entry');
    const link = node('a', undefined, 'list-link'), query = parameters(item.ref);
    if (currentPage !== undefined) query.set('page', String(currentPage));
    link.href = '/addresses?' + query;
    link.setAttribute('aria-current', String(item.ref.uid === selected?.metadata.uid));
    link.append(node('strong', item.name), node('span', types[item.type], 'muted'));
    const indicators = node('span', undefined, 'address-indicators');
    if (defaultUid === item.ref.uid) indicators.append(statusIcon('默认通知地址', '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>'));
    if (item.muted) indicators.append(statusIcon('Aide 已被禁言', '<path d="m3 3 18 18M9 5l3-2v9M6 8H3v8h4l5 5v-5m4-10a9 9 0 0 1 3 9M15 9a5 5 0 0 1 1 3"/>'));
    if (indicators.childElementCount) link.append(indicators);
    link.onclick = event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return; event.preventDefault(); void select(item.ref).catch(report); };
    const button = node('button', '⋯', 'address-more'); button.type = 'button'; button.title = '地址操作'; button.dataset.uid = item.ref.uid;
    button.setAttribute('aria-label', '地址操作：' + item.name); button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-controls', menu.id); button.setAttribute('aria-expanded', 'false'); button.disabled = busy || listLoading;
    button.onclick = () => {
      const wasOpen = menu.matches(':popover-open'); menu.hidePopover(); menuButton?.setAttribute('aria-expanded', 'false');
      if (wasOpen && menuButton === button) return;
      menuButton = button; menu.replaceChildren();
      const isDefault = defaultUid === item.ref.uid;
      for (const [action, label, disabled] of [
        ['default', isDefault ? '默认通知地址' : '设为默认通知地址', !settings || isDefault || !['direct', 'web'].includes(item.type)],
        ['mute', item.muted ? '解除禁言' : '禁言 Aide', false],
      ] as const) {
        const option = node('button', label); option.type = 'button'; option.setAttribute('role', 'menuitem'); option.disabled = disabled;
        option.onclick = () => { void changeAddress(item, action); }; menu.append(option);
      }
      menu.showPopover(); button.setAttribute('aria-expanded', 'true');
      const rect = button.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 8)) + 'px';
      menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    };
    row.append(link, button); return row;
  }));
}
/** @spec Sidebar actions target their own Address UID, independently of the selected detail or its unsaved summary. */
async function changeAddress(item: Item, action: 'default' | 'mute') {
  menu.hidePopover(); if (busy || listLoading) return;
  setBusy(true);
  try {
    if (action === 'default') {
      if (!settings) return;
      settings = await request<ChannelSettingsView>('/channels/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'default', revision: settings.revision, address: item.ref }) });
      await list(); $('notice').textContent = '已将「' + item.name + '」设为默认通知地址';
    } else {
      const updated = await request<View>('/addresses/muted', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: item.ref, muted: !item.muted, expected: item.muted }) });
      const next = { ...item, ...updated.spec };
      items.set(item.ref.uid, next);
      if (selected?.metadata.uid === item.ref.uid) render(updated);
      renderList(); $('notice').textContent = updated.spec.muted ? '已在「' + item.name + '」禁言 Aide' : '已解除「' + item.name + '」的禁言';
    }
  } catch (error) { await loadSettings(); await list(); report(error); }
  finally { setBusy(false); document.querySelector<HTMLButtonElement>('.address-more[data-uid="' + CSS.escape(item.ref.uid) + '"]')?.focus(); }
}
void loadSettings();
$('edit').onclick = () => { if (!selected) return; $<HTMLTextAreaElement>('text').value = selected.summaryText; $('editor').hidden = false; $('summary').hidden = true; $('text').focus(); };
$('cancel').onclick = () => { if (busy) return; $('editor').hidden = true; $('summary').hidden = false; };
$('editor').onsubmit = async event => { event.preventDefault(); if (!selected || busy) return; if (await save('/addresses/summary', { text: $<HTMLTextAreaElement>('text').value, version: selected.summaryVersion })) { $('editor').hidden = true; $('summary').hidden = false; } };
const tabs = ['summary', 'notes', 'people'];
function tab(name: string) { for (const key of tabs) { const active = key === name; $('tab-' + key).setAttribute('aria-selected', String(active)); $('tab-' + key).tabIndex = active ? 0 : -1; $('panel-' + key).hidden = !active; } }
for (const [index, name] of tabs.entries()) {
  $('tab-' + name).onclick = () => tab(name);
  $('tab-' + name).onkeydown = event => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1; if (next >= 0) { event.preventDefault(); tab(tabs[next]!); $('tab-' + tabs[next]).focus(); } };
}
for (const [id, delta] of [['address-previous', -1], ['address-next', 1]] as const) {
  $(id).onclick = () => { if (page && !busy && !listLoading) void list(page.page + delta); };
}
$('refresh').onclick = () => { void (async () => { if (busy || listLoading) return; await loadSettings(); await list(); if (selected && $('editor').hidden) await select(currentRef()); })().catch(report); };
$('notes-more').onclick = () => { void loadNotes().catch(report); };
const initialPage = Number(new URL(location.href).searchParams.get('page'));
if (Number.isSafeInteger(initialPage) && initialPage > 0) currentPage = initialPage;
void list().then(async () => { const q = new URLSearchParams(location.search); if (q.get('name') && q.get('uid')) await select({ apiVersion: 'aide.dev/v1alpha1', kind: 'Address', namespace: 'v1', name: q.get('name')!, uid: q.get('uid')! }); }).catch(report);
