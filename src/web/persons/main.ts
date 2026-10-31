import './style.css';
import { renderDelivery, readDelivery, deliveryDirty, disableDelivery } from './delivery.ts';
import { PersonMerge } from './merge.ts';
import { PersonNotes } from './notes.ts';
import { mountPersonTabs } from './tabs.ts';
import { renderMarkdown } from '../shared/markdown.ts';
import { byId as $, element as node, find } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import type { PersonView, PersonItem, PersonListView } from '../../api/types.ts';
import type { Person, PersonIdentity } from '../../../plugins/personal/person/model.ts';

let people: PersonItem[] = [], selected: PersonView, page: PersonListView | undefined;
let listRequest: AbortController | undefined, detailRequest: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined, searchTimer: ReturnType<typeof setTimeout> | undefined, paused = false;
let listGeneration = 0, detailGeneration = 0, lastList = '';
let editingSummary = false, saving = false;
let requestedPage: number | null = null, currentPage = 1;
const initialId = new URL(location.href).searchParams.get('person');
const initialUid = new URL(location.href).searchParams.get('uid');
const records = new PersonNotes();
const tabs = mountPersonTabs(() => records.show());
const merging = new PersonMerge({ current: () => selected, hasUnsavedChanges, busy: setSaving,
  merged(source, target) {
    people = people.filter((p) => p.uid !== source.metadata.uid);
    adoptPerson(target); renderEditor();
    $('person-notice').textContent = '已合并，被合并人物已删除。';
  },
});
function identities(): PersonIdentity[] {
  return [...$('person-identities').children].map(row => ({
    provider: find<HTMLInputElement>(row, '[data-key=provider]').value,
    scope: find<HTMLInputElement>(row, '[data-key=scope]').value,
    id: find<HTMLInputElement>(row, '[data-key=id]').value,
  }));
}
function hasUnsavedChanges() {
  return saving || (selected && ($<HTMLInputElement>('person-name').value !== selected.spec.name
    || $<HTMLSelectElement>('person-clearance').value !== (selected.spec.clearance ?? 'L1')
    || deliveryDirty(selected.spec.delivery)
    || JSON.stringify(identities()) !== JSON.stringify(selected.spec.identities)
    || (editingSummary && $<HTMLTextAreaElement>('person-summary').value !== selected.summaryText)));
}
function renderList() {
  if (!page) return;
  const total = page.total + page.pinned.length;
  $('person-count').textContent = String(total);
  const signature = JSON.stringify({ page, selected: selected?.metadata.uid, q: $<HTMLInputElement>('person-search').value.trim() });
  if (signature === lastList) return;
  lastList = signature;
  $('person-list').replaceChildren();
  currentPage = page.page;
  if (requestedPage !== null) requestedPage = currentPage;
  for (const person of people) {
    const link = node('a', undefined, 'list-link');
    const params = new URLSearchParams({ person: person.id, uid: person.uid });
    const q = $<HTMLInputElement>('person-search').value.trim(); if (q) params.set('q', q);
    params.set('page', String(currentPage)); link.href = '/people?' + params;
    if (selected?.metadata.uid === person.uid) link.setAttribute('aria-current', 'page');
    link.append(node('strong', person.name + (person.isMe ? ' · 我' : '')), node('span', person.preview || '尚未积累认识', 'muted'));
    if (person.updatedAt) link.append(node('span', new Date(person.updatedAt).toLocaleString(), 'muted'));
    link.onclick = async (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
      event.preventDefault();
      if (saving || (hasUnsavedChanges() && !confirm('放弃尚未保存的修改？'))) return;
      await select(person.id, person.uid);
    };
    $('person-list').append(link);
  }
  $('person-pagination').hidden = page.pages <= 1;
  $('person-page').textContent = `${page.page} / ${page.pages}`;
  $<HTMLButtonElement>('person-previous').disabled = page.page <= 1;
  $<HTMLButtonElement>('person-next').disabled = page.page >= page.pages;
  $('person-list-notice').textContent = total ? `${total} 位人物` : '没有匹配的人物。';
}
function saveLocation() {
  const url = new URL(location.href);
  if (selected) { url.searchParams.set('person', selected.metadata.name); url.searchParams.set('uid', selected.metadata.uid); }
  const q = $<HTMLInputElement>('person-search').value.trim();
  if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
  if (requestedPage !== null) url.searchParams.set('page', String(requestedPage)); else url.searchParams.delete('page');
  history.replaceState(null, '', url);
}
async function loadPeople() {
  clearTimeout(timer); listRequest?.abort();
  const controller = new AbortController(), token = ++listGeneration;
  listRequest = controller;
  const query = new URLSearchParams({ pageSize: '10' });
  const q = $<HTMLInputElement>('person-search').value.trim(); if (q) query.set('q', q);
  if (requestedPage !== null) query.set('page', String(requestedPage));
  const id = selected?.metadata.name ?? initialId; if (id) query.set('selectedId', id);
  try {
    const result = await request<PersonListView>('/persons?' + query, { signal: controller.signal });
    if (token !== listGeneration || paused) return;
    page = result; people = [...result.pinned, ...result.items]; renderList(); saveLocation();
  } catch (error) { if (token === listGeneration && !paused) $('person-list-notice').textContent = errorMessage(error); }
  finally {
    if (token === listGeneration) {
      listRequest = undefined;
      schedulePeople();
    }
  }
}
function schedulePeople() { clearTimeout(timer); if (!paused) timer = setTimeout(() => void loadPeople(), 5000); }
function identityRow(identity: PersonIdentity = { provider: '', scope: '', id: '' }) {
  const row = node('div', undefined, 'person-identity');
  const local = identity.provider === 'web' && identity.scope === 'local' && identity.id === 'me';
  for (const [key, label] of [['provider', '系统'], ['scope', '身份作用域'], ['id', '身份 ID']] as const) {
    const field = node('input'); field.value = identity[key]; field.placeholder = label; field.setAttribute('aria-label', label); field.dataset.key = key; field.required = true; field.readOnly = local; if (local) field.dataset.local = ''; row.append(field);
  }
  const remove = node('button', '移除', 'secondary'); remove.type = 'button'; remove.disabled = local; if (local) remove.dataset.local = ''; remove.onclick = () => row.remove(); row.append(remove); $('person-identities').append(row);
}
function renderSummary() {
  const text = selected.summaryText;
  $('person-summary-read').innerHTML = renderMarkdown(text || '尚未积累认识。');
  $('person-summary-read').classList.toggle('muted', !text);
  $<HTMLTextAreaElement>('person-summary').value = text;
}
function setSummaryEditing(editing: boolean) {
  editingSummary = editing;
  $('person-summary-read').hidden = editing;
  $('person-summary-editor').hidden = !editing;
  $<HTMLButtonElement>('person-summary-edit').hidden = editing;
  $<HTMLButtonElement>('person-summary-edit').setAttribute('aria-expanded', String(editing));
  $('person-summary-notice').textContent = '';
}
function setNameEditing(editing: boolean) {
  $('person-name-form').hidden = !editing;
  $('person-name-edit').hidden = editing;
  $('person-name-edit').setAttribute('aria-expanded', String(editing));
  if (!editing) $<HTMLInputElement>('person-name').value = selected.spec.name;
}
function setSaving(value: boolean) {
  saving = value;
  disableDelivery(value);
  $<HTMLSelectElement>('person-clearance').disabled = value;
  for (const id of ['person-save', 'person-name-edit', 'person-name-cancel', 'person-name-save', 'person-reload', 'person-summary-edit', 'person-summary-cancel', 'person-summary-confirm', 'identity-add']) $<HTMLButtonElement>(id).disabled = value;
  $<HTMLTextAreaElement>('person-summary').readOnly = value;
  $<HTMLInputElement>('person-name').readOnly = value;
  for (const field of $('person-identities').querySelectorAll<HTMLInputElement>('input:not([data-local])')) field.readOnly = value;
  for (const button of $('person-identities').querySelectorAll<HTMLButtonElement>('button:not([data-local])')) button.disabled = value;
}
function adoptPerson(person: PersonView, refreshList = true) {
  if (selected?.metadata.uid !== person.metadata.uid) tabs.reset();
  selected = { ...selected, ...person };
  $('person-heading').textContent = selected.spec.name + (selected.isMe ? ' · 我' : '');
  $('person-updated').textContent = selected.status.updatedAt ? '最近更新：' + new Date(selected.status.updatedAt).toLocaleString() : '';
  renderList();
  void merging.render();
  if (refreshList) void loadPeople();
}
function renderEditor() {
  $('person-empty').hidden = true; $('person-editor').hidden = false;
  $<HTMLInputElement>('person-name').value = selected.spec.name;
  renderSummary(); setSummaryEditing(false); setNameEditing(false);
  $('person-identities').replaceChildren(); selected.spec.identities.forEach(identityRow);
  $<HTMLSelectElement>('person-clearance').value = selected.spec.clearance ?? 'L1';
  renderDelivery(selected.spec.delivery);
  records.reset(selected); tabs.refresh();
}
async function select(id: string, uid?: string) {
  detailRequest?.abort(); const controller = new AbortController(), token = ++detailGeneration;
  detailRequest = controller;
  try {
    const person = await request<PersonView>('/persons?' + new URLSearchParams({ id, ...(uid ? { uid } : {}) }), { signal: controller.signal });
    if (token !== detailGeneration || paused) return;
    adoptPerson(person, false); renderEditor();
    $('person-notice').textContent = ''; saveLocation();
  } catch (error) {
    if (token !== detailGeneration || paused) return;
    $('person-notice').textContent = errorMessage(error);
    if (!selected) { $('person-heading').textContent = '人物不可用'; $('person-empty').textContent = '人物可能已删除。历史消息仍可正常查看，请从左侧选择其他人物。'; }
  }
}
function savePerson(spec: Person, summary?: string) {
  return request<PersonView>('/persons/edit', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: selected.metadata.name, uid: selected.metadata.uid, version: selected.metadata.resourceVersion, spec, summary }) });
}
$<HTMLInputElement>('person-search').oninput = () => { requestedPage = 1; listGeneration++; listRequest?.abort(); clearTimeout(timer); clearTimeout(searchTimer); searchTimer = setTimeout(() => void loadPeople(), 250); };
$('person-previous').onclick = () => { requestedPage = currentPage - 1; void loadPeople(); };
$('person-next').onclick = () => { requestedPage = currentPage + 1; void loadPeople(); };
$('identity-add').onclick = () => identityRow();
$<HTMLButtonElement>('person-reload').onclick = () => { if (!saving && (!hasUnsavedChanges() || confirm('重新加载将放弃尚未保存的修改，继续？'))) void select(selected.metadata.name, selected.metadata.uid); };
$<HTMLButtonElement>('person-summary-edit').onclick = () => {
  renderSummary(); setSummaryEditing(true); $<HTMLTextAreaElement>('person-summary').focus();
};
$<HTMLButtonElement>('person-summary-cancel').onclick = () => {
  renderSummary(); setSummaryEditing(false); $<HTMLButtonElement>('person-summary-edit').focus();
};
// @spec Confirm replaces the shared summary; cancellation never saves and a conflict keeps the draft open.
$<HTMLButtonElement>('person-summary-confirm').onclick = async () => {
  if (saving) return;
  setSaving(true);
  try {
    adoptPerson(await savePerson(selected.spec, $<HTMLTextAreaElement>('person-summary').value));
    renderSummary(); setSummaryEditing(false); $<HTMLButtonElement>('person-summary-edit').focus();
    $('person-summary-notice').textContent = '已保存。';
  } catch (error) { $('person-summary-notice').textContent = errorMessage(error); }
  finally { setSaving(false); }
};
// @spec Saving one profile area preserves unsaved drafts in the other areas.
async function saveProfile(area: 'name' | 'identities') {
  if (!selected || saving) return;
  const spec = { ...selected.spec, ...(area === 'name' ? { name: $<HTMLInputElement>('person-name').value } : { identities: identities(), clearance: $<HTMLSelectElement>('person-clearance').value as NonNullable<Person['clearance']> }) };
  setSaving(true);
  try {
    adoptPerson(await savePerson(spec));
    if (area === 'name') setNameEditing(false);
    else { $('person-identities').replaceChildren(); selected.spec.identities.forEach(identityRow);
  $<HTMLSelectElement>('person-clearance').value = selected.spec.clearance ?? 'L1'; }
    $('person-notice').textContent = area === 'name' ? '称呼已保存。' : '身份已保存。';
  } catch (error) { $('person-notice').textContent = errorMessage(error); }
  finally {
    setSaving(false);
    if (area === 'name' && $('person-name-form').hidden) $('person-name-edit').focus();
  }
}
$('person-delivery-form').onsubmit = async event => {
  event.preventDefault();
  if (!selected || saving) return;
  try {
    const delivery = readDelivery();
    setSaving(true);
    adoptPerson(await savePerson({ ...selected.spec, delivery }));
    renderDelivery(selected.spec.delivery);
    $('person-notice').textContent = '投递频率已保存。';
  } catch (error) { $('person-notice').textContent = errorMessage(error); }
  finally { setSaving(false); }
};
$('person-name-edit').onclick = () => { setNameEditing(true); $<HTMLInputElement>('person-name').focus(); };
$('person-name-cancel').onclick = () => { setNameEditing(false); $('person-name-edit').focus(); };
$('person-name-form').onkeydown = event => {
  if (event.key === 'Escape' && !saving) { event.preventDefault(); setNameEditing(false); $('person-name-edit').focus(); }
};
$('person-name-form').onsubmit = event => { event.preventDefault(); void saveProfile('name'); };
$('person-identities-form').onsubmit = event => { event.preventDefault(); void saveProfile('identities'); };
window.addEventListener('beforeunload', (event) => { if (hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => {
  paused = true; listGeneration++; detailGeneration++;
  clearTimeout(timer); clearTimeout(searchTimer); listRequest?.abort(); detailRequest?.abort(); merging.pause(); records.pause();
});
window.addEventListener('pageshow', event => { if (event.persisted) { paused = false; void loadPeople(); if (selected) { void merging.render(); tabs.refresh(); } } });
const initialParams = new URL(location.href).searchParams;
$<HTMLInputElement>('person-search').value = initialParams.get('q') ?? '';
const initialPage = Number(initialParams.get('page'));
if (Number.isSafeInteger(initialPage) && initialPage > 0) requestedPage = initialPage;
await loadPeople();
const initialPerson = people.find(p => p.isMe);
if (initialId || initialPerson) await select(initialId ?? initialPerson!.id, initialId ? initialUid ?? undefined : initialPerson!.uid);
