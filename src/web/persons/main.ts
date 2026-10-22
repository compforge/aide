import './style.css';
import { renderMarkdown } from '../shared/markdown.ts';
import { byId as $, element as node, find } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import type { PersonView } from '../../api/types.ts';
import type { Person, PersonIdentity } from '../../../plugins/personal/person/model.ts';

let people: PersonView[] = [], selected: PersonView;
let dirty = false, editingUnderstanding = false, saving = false;
const initialId = new URL(location.href).searchParams.get('person');
function hasUnsavedChanges() {
  return dirty || saving || (editingUnderstanding && $<HTMLTextAreaElement>('person-understanding').value !== selected.spec.profile.understanding);
}
function renderList() {
  $('person-list').replaceChildren();
  const query = $<HTMLInputElement>('person-search').value.trim().toLowerCase();
  for (const person of people.filter((p) => p.spec.name.toLowerCase().includes(query))) {
    const link = node('a', undefined, 'list-link'); link.href = '/people?person=' + encodeURIComponent(person.metadata.name);
    if (selected?.metadata.name === person.metadata.name) link.setAttribute('aria-current', 'page');
    link.append(node('strong', person.spec.name + (person.isMe ? ' · 我' : '')), node('span', person.spec.profile.understanding.slice(0, 80) || '尚未积累认识', 'muted'));
    if (person.status.updatedAt) link.append(node('span', new Date(person.status.updatedAt).toLocaleString(), 'muted'));
    link.onclick = async (event) => {
      event.preventDefault();
      if (saving || (hasUnsavedChanges() && !confirm('放弃尚未保存的修改？'))) return;
      await select(person.metadata.name);
    };
    $('person-list').append(link);
  }
  $('person-list-notice').textContent = people.length ? `${people.length} 位人物` : '还没有人物。';
}
function identityRow(identity: PersonIdentity = { provider: '', scope: '', id: '' }) {
  const row = node('div', undefined, 'person-identity');
  const local = identity.provider === 'web' && identity.scope === 'local' && identity.id === 'me';
  for (const [key, label] of [['provider', '系统'], ['scope', '身份作用域'], ['id', '身份 ID']] as const) {
    const field = node('input'); field.value = identity[key]; field.placeholder = label; field.setAttribute('aria-label', label); field.dataset.key = key; field.required = true; field.readOnly = local; row.append(field);
  }
  const remove = node('button', '移除', 'secondary'); remove.type = 'button'; remove.disabled = local; remove.onclick = () => { row.remove(); dirty = true; }; row.append(remove); $('person-identities').append(row);
}
function renderUnderstanding() {
  const text = selected.spec.profile.understanding;
  $('person-understanding-read').innerHTML = renderMarkdown(text || '尚未积累认识。');
  $('person-understanding-read').classList.toggle('muted', !text);
  $<HTMLTextAreaElement>('person-understanding').value = text;
}
function setUnderstandingEditing(editing: boolean) {
  editingUnderstanding = editing;
  $('person-understanding-read').hidden = editing;
  $('person-understanding-editor').hidden = !editing;
  $<HTMLButtonElement>('person-understanding-edit').hidden = editing;
  $<HTMLButtonElement>('person-understanding-edit').setAttribute('aria-expanded', String(editing));
  $<HTMLButtonElement>('person-save').disabled = editing || saving;
  $('person-understanding-notice').textContent = '';
}
function setSaving(value: boolean) {
  saving = value;
  $<HTMLButtonElement>('person-save').disabled = value || editingUnderstanding;
  for (const id of ['person-reload', 'person-understanding-edit', 'person-understanding-cancel', 'person-understanding-confirm']) $<HTMLButtonElement>(id).disabled = value;
  $<HTMLTextAreaElement>('person-understanding').readOnly = value;
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
    renderUnderstanding(); setUnderstandingEditing(false);
    $('person-identities').replaceChildren(); selected.spec.identities.forEach(identityRow);
    $('person-notice').textContent = ''; history.replaceState(null, '', '/people?person=' + encodeURIComponent(id));
  } catch (error) { $('person-notice').textContent = errorMessage(error); }
}
function savePerson(spec: Person) {
  return request<PersonView>('/persons/edit', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: selected.metadata.name, uid: selected.metadata.uid, version: selected.metadata.resourceVersion, spec }) });
}
$<HTMLInputElement>('person-search').oninput = renderList;
$('person-editor').oninput = (event) => { if (event.target !== $<HTMLTextAreaElement>('person-understanding')) dirty = true; };
$('identity-add').onclick = () => { identityRow(); dirty = true; };
$<HTMLButtonElement>('person-reload').onclick = () => { if (!saving && (!hasUnsavedChanges() || confirm('重新加载将放弃尚未保存的修改，继续？'))) void select(selected.metadata.name); };
$<HTMLButtonElement>('person-understanding-edit').onclick = () => {
  renderUnderstanding(); setUnderstandingEditing(true); $<HTMLTextAreaElement>('person-understanding').focus();
};
$<HTMLButtonElement>('person-understanding-cancel').onclick = () => {
  renderUnderstanding(); setUnderstandingEditing(false); $<HTMLButtonElement>('person-understanding-edit').focus();
};
// @spec Confirm writes only understanding; cancellation never saves and a conflict keeps the draft open.
$<HTMLButtonElement>('person-understanding-confirm').onclick = async () => {
  if (saving) return;
  setSaving(true);
  try {
    const spec = { ...selected.spec, profile: { ...selected.spec.profile, understanding: $<HTMLTextAreaElement>('person-understanding').value } };
    adoptPerson(await savePerson(spec));
    renderUnderstanding(); setUnderstandingEditing(false); $<HTMLButtonElement>('person-understanding-edit').focus();
    $('person-understanding-notice').textContent = '已保存。';
  } catch (error) { $('person-understanding-notice').textContent = errorMessage(error); }
  finally { setSaving(false); }
};
$('person-editor').onsubmit = async (event) => {
  event.preventDefault(); if (!selected || saving || editingUnderstanding) return;
  setSaving(true);
  const spec = { name: $<HTMLInputElement>('person-name').value, profile: selected.spec.profile,
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
