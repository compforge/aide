import { renderMarkdown } from '/agentue.js';

const $ = (id) => document.getElementById(id);
let people = [], selected, dirty = false, editingUnderstanding = false, saving = false;
const initialId = new URL(location.href).searchParams.get('person');
async function request(path, init) {
  const response = await fetch(path, init); const data = await response.json();
  if (!response.ok) throw new Error(data.error || '加载失败，请重试。');
  return data;
}
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function hasUnsavedChanges() {
  return dirty || saving || (editingUnderstanding && $('person-understanding').value !== selected.spec.profile.understanding);
}
function renderList() {
  $('person-list').replaceChildren();
  const query = $('person-search').value.trim().toLowerCase();
  for (const person of people.filter((p) => p.spec.name.toLowerCase().includes(query))) {
    const link = node('a', undefined, 'conversation-link'); link.href = '/people?person=' + encodeURIComponent(person.metadata.name);
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
function identityRow(identity = { provider: '', scope: '', id: '' }) {
  const row = node('div', undefined, 'person-identity');
  const local = identity.provider === 'web' && identity.scope === 'local' && identity.id === 'me';
  for (const [key, label] of [['provider', '系统'], ['scope', '身份作用域'], ['id', '身份 ID']]) {
    const field = node('input'); field.value = identity[key]; field.placeholder = label; field.setAttribute('aria-label', label); field.dataset.key = key; field.required = true; field.readOnly = local; row.append(field);
  }
  const remove = node('button', '移除', 'secondary'); remove.type = 'button'; remove.disabled = local; remove.onclick = () => { row.remove(); dirty = true; }; row.append(remove); $('person-identities').append(row);
}
function renderUnderstanding() {
  const text = selected.spec.profile.understanding;
  $('person-understanding-read').innerHTML = renderMarkdown(text || '尚未积累认识。');
  $('person-understanding-read').classList.toggle('muted', !text);
  $('person-understanding').value = text;
}
function setUnderstandingEditing(editing) {
  editingUnderstanding = editing;
  $('person-understanding-read').hidden = editing;
  $('person-understanding-editor').hidden = !editing;
  $('person-understanding-edit').hidden = editing;
  $('person-understanding-edit').setAttribute('aria-expanded', String(editing));
  $('person-save').disabled = editing || saving;
  $('person-understanding-notice').textContent = '';
}
function setSaving(value) {
  saving = value;
  $('person-save').disabled = value || editingUnderstanding;
  for (const id of ['person-reload', 'person-understanding-edit', 'person-understanding-cancel', 'person-understanding-confirm']) $(id).disabled = value;
  $('person-understanding').readOnly = value;
}
function adoptPerson(person) {
  selected = { ...selected, ...person };
  people = people.map((p) => p.metadata.name === person.metadata.name ? { ...p, ...selected } : p);
  $('person-heading').textContent = selected.spec.name + (selected.isMe ? ' · 我' : '');
  $('person-updated').textContent = selected.status.updatedAt ? '最近更新：' + new Date(selected.status.updatedAt).toLocaleString() : '';
  renderList();
}
async function select(id) {
  try {
    adoptPerson(await request('/persons?id=' + encodeURIComponent(id))); dirty = false;
    $('person-empty').hidden = true; $('person-editor').hidden = false;
    $('person-name').value = selected.spec.name;
    renderUnderstanding(); setUnderstandingEditing(false);
    $('person-identities').replaceChildren(); selected.spec.identities.forEach(identityRow);
    $('person-notice').textContent = ''; history.replaceState(null, '', '/people?person=' + encodeURIComponent(id));
  } catch (error) { $('person-notice').textContent = error.message; }
}
function savePerson(spec) {
  return request('/persons/edit', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: selected.metadata.name, uid: selected.metadata.uid, version: selected.metadata.resourceVersion, spec }) });
}
$('person-search').oninput = renderList;
$('person-editor').oninput = (event) => { if (event.target !== $('person-understanding')) dirty = true; };
$('identity-add').onclick = () => { identityRow(); dirty = true; };
$('person-reload').onclick = () => { if (!saving && (!hasUnsavedChanges() || confirm('重新加载将放弃尚未保存的修改，继续？'))) void select(selected.metadata.name); };
$('person-understanding-edit').onclick = () => {
  renderUnderstanding(); setUnderstandingEditing(true); $('person-understanding').focus();
};
$('person-understanding-cancel').onclick = () => {
  renderUnderstanding(); setUnderstandingEditing(false); $('person-understanding-edit').focus();
};
// @spec Confirm writes only understanding; cancellation never saves and a conflict keeps the draft open.
$('person-understanding-confirm').onclick = async () => {
  if (saving) return;
  setSaving(true);
  try {
    const spec = { ...selected.spec, profile: { ...selected.spec.profile, understanding: $('person-understanding').value } };
    adoptPerson(await savePerson(spec));
    renderUnderstanding(); setUnderstandingEditing(false); $('person-understanding-edit').focus();
    $('person-understanding-notice').textContent = '已保存。';
  } catch (error) { $('person-understanding-notice').textContent = error.message; }
  finally { setSaving(false); }
};
$('person-editor').onsubmit = async (event) => {
  event.preventDefault(); if (!selected || saving || editingUnderstanding) return;
  setSaving(true);
  const spec = { name: $('person-name').value, profile: selected.spec.profile,
    identities: [...$('person-identities').children].map((row) => Object.fromEntries([...row.querySelectorAll('input')].map((input) => [input.dataset.key, input.value]))) };
  try {
    adoptPerson(await savePerson(spec)); dirty = false;
    $('person-name').value = selected.spec.name;
    $('person-identities').replaceChildren(); selected.spec.identities.forEach(identityRow);
    $('person-notice').textContent = '已保存。';
  } catch (error) { $('person-notice').textContent = error.message; }
  finally { setSaving(false); }
};
window.addEventListener('beforeunload', (event) => { if (hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; } });
try { people = await request('/persons'); renderList(); const id = initialId || people.find((p) => p.isMe)?.metadata.name; if (id) await select(id); }
catch (error) { $('person-list-notice').textContent = error.message; }
