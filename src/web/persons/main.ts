import './style.css';
import { personPage } from './pagination.ts';
import { renderMarkdown } from '../shared/markdown.ts';
import { byId as $, element as node, find } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import type { PersonView } from '../../api/types.ts';
import type { Person, PersonIdentity } from '../../../plugins/personal/person/model.ts';

let people: PersonView[] = [], selected: PersonView;
let dirty = false, editingSummary = false, saving = false;
let requestedPage: number | null = null, currentPage = 1;
const initialId = new URL(location.href).searchParams.get('person');
function hasUnsavedChanges() {
  return dirty || saving || (editingSummary && $<HTMLTextAreaElement>('person-summary').value !== selected.status.summary);
}
function renderList() {
  $('person-list').replaceChildren();
  const query = $<HTMLInputElement>('person-search').value.trim().toLowerCase();
  const result = personPage(people, query, requestedPage, selected?.metadata.name ?? initialId);
  currentPage = result.page;
  if (requestedPage !== null) requestedPage = currentPage;
  for (const person of result.items) {
    const link = node('a', undefined, 'list-link'); link.href = '/people?person=' + encodeURIComponent(person.metadata.name);
    if (selected?.metadata.name === person.metadata.name) link.setAttribute('aria-current', 'page');
    link.append(node('strong', person.spec.name + (person.isMe ? ' · 我' : '')), node('span', person.status.summary.trim().slice(0, 80) || '尚未积累认识', 'muted'));
    if (person.status.updatedAt) link.append(node('span', new Date(person.status.updatedAt).toLocaleString(), 'muted'));
    link.onclick = async (event) => {
      event.preventDefault();
      if (saving || (hasUnsavedChanges() && !confirm('放弃尚未保存的修改？'))) return;
      await select(person.metadata.name);
    };
    $('person-list').append(link);
  }
  $('person-pagination').hidden = result.pages <= 1;
  $('person-page').textContent = `${result.page} / ${result.pages}`;
  $<HTMLButtonElement>('person-previous').disabled = result.page <= 1;
  $<HTMLButtonElement>('person-next').disabled = result.page >= result.pages;
  $('person-list-notice').textContent = !people.length ? '还没有人物。' : result.total ? `${result.total} 位人物` : '没有匹配的人物。';
}
function identityRow(identity: PersonIdentity = { provider: '', scope: '', id: '' }) {
  const row = node('div', undefined, 'person-identity');
  const local = identity.provider === 'web' && identity.scope === 'local' && identity.id === 'me';
  for (const [key, label] of [['provider', '系统'], ['scope', '身份作用域'], ['id', '身份 ID']] as const) {
    const field = node('input'); field.value = identity[key]; field.placeholder = label; field.setAttribute('aria-label', label); field.dataset.key = key; field.required = true; field.readOnly = local; row.append(field);
  }
  const remove = node('button', '移除', 'secondary'); remove.type = 'button'; remove.disabled = local; remove.onclick = () => { row.remove(); dirty = true; }; row.append(remove); $('person-identities').append(row);
}
function renderSummary() {
  $('person-recent').replaceChildren(...selected.status.recent.map((entry) => node('p', `${entry.at} · ${entry.text}`)));
  const text = selected.status.summary;
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
  $<HTMLButtonElement>('person-save').disabled = editing || saving;
  $('person-summary-notice').textContent = '';
}
function setSaving(value: boolean) {
  saving = value;
  $<HTMLButtonElement>('person-save').disabled = value || editingSummary;
  for (const id of ['person-reload', 'person-summary-edit', 'person-summary-cancel', 'person-summary-confirm']) $<HTMLButtonElement>(id).disabled = value;
  $<HTMLTextAreaElement>('person-summary').readOnly = value;
}
function adoptPerson(person: PersonView) {
  selected = { ...selected, ...person };
  people = people.map((p) => p.metadata.name === person.metadata.name ? { ...p, ...selected } : p);
  $('person-heading').textContent = selected.spec.name + (selected.isMe ? ' · 我' : '');
  $('person-updated').textContent = selected.status.updatedAt ? '最近更新：' + new Date(selected.status.updatedAt).toLocaleString() : '';
  renderList();
}
async function select(id: string) {
  try {
    adoptPerson(await request<PersonView>('/persons?id=' + encodeURIComponent(id))); dirty = false;
    $('person-empty').hidden = true; $('person-editor').hidden = false;
    $<HTMLInputElement>('person-name').value = selected.spec.name;
    renderSummary(); setSummaryEditing(false);
    $('person-identities').replaceChildren(); selected.spec.identities.forEach(identityRow);
    $('person-notice').textContent = ''; history.replaceState(null, '', '/people?person=' + encodeURIComponent(id));
  } catch (error) { $('person-notice').textContent = errorMessage(error); }
}
function savePerson(spec: Person, summary?: string) {
  return request<PersonView>('/persons/edit', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: selected.metadata.name, uid: selected.metadata.uid, version: selected.metadata.resourceVersion, spec, summary }) });
}
$<HTMLInputElement>('person-search').oninput = () => { requestedPage = 1; renderList(); };
$('person-previous').onclick = () => { requestedPage = currentPage - 1; renderList(); };
$('person-next').onclick = () => { requestedPage = currentPage + 1; renderList(); };
$('person-editor').oninput = (event) => { if (event.target !== $<HTMLTextAreaElement>('person-summary')) dirty = true; };
$('identity-add').onclick = () => { identityRow(); dirty = true; };
$<HTMLButtonElement>('person-reload').onclick = () => { if (!saving && (!hasUnsavedChanges() || confirm('重新加载将放弃尚未保存的修改，继续？'))) void select(selected.metadata.name); };
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
$('person-editor').onsubmit = async (event) => {
  event.preventDefault(); if (!selected || saving || editingSummary) return;
  setSaving(true);
  const spec = { name: $<HTMLInputElement>('person-name').value,
    identities: [...$('person-identities').children].map((row) => ({ provider: find<HTMLInputElement>(row, '[data-key=provider]').value, scope: find<HTMLInputElement>(row, '[data-key=scope]').value, id: find<HTMLInputElement>(row, '[data-key=id]').value })) };
  try {
    adoptPerson(await savePerson(spec)); dirty = false;
    $<HTMLInputElement>('person-name').value = selected.spec.name;
    $('person-identities').replaceChildren(); selected.spec.identities.forEach(identityRow);
    $('person-notice').textContent = '已保存。';
  } catch (error) { $('person-notice').textContent = errorMessage(error); }
  finally { setSaving(false); }
};
window.addEventListener('beforeunload', (event) => { if (hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; } });
try { people = await request<PersonView[]>('/persons'); renderList(); const id = initialId || people.find((p) => p.isMe)?.metadata.name; if (id) await select(id); }
catch (error) { $('person-list-notice').textContent = errorMessage(error); }
