const $ = (id) => document.getElementById(id);
let people = [], selected, dirty = false;
const initialId = new URL(location.href).searchParams.get('person');
async function request(path, init) {
  const response = await fetch(path, init); const data = await response.json();
  if (!response.ok) throw new Error(data.error || '加载失败，请重试。');
  return data;
}
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function renderList() {
  $('person-list').replaceChildren();
  const query = $('person-search').value.trim().toLowerCase();
  for (const person of people.filter((p) => p.spec.name.toLowerCase().includes(query))) {
    const link = node('a', undefined, 'conversation-link'); link.href = '/people?person=' + encodeURIComponent(person.metadata.name);
    if (selected?.metadata.name === person.metadata.name) link.setAttribute('aria-current', 'page');
    link.append(node('strong', person.spec.name + (person.isMe ? ' · 我' : '')), node('span', person.spec.profile.understanding.slice(0, 80) || '尚未积累认识', 'muted'));
    if (person.status.updatedAt) link.append(node('span', new Date(person.status.updatedAt).toLocaleString(), 'muted'));
    link.onclick = async (event) => { event.preventDefault(); if (dirty && !confirm('放弃尚未保存的修改？')) return; await select(person.metadata.name); };
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
async function select(id) {
  try {
    const person = await request('/persons?id=' + encodeURIComponent(id)); selected = person; dirty = false;
    $('person-heading').textContent = person.spec.name + (person.isMe ? ' · 我' : ''); $('person-empty').hidden = true; $('person-editor').hidden = false;
    $('person-name').value = person.spec.name; $('person-understanding').value = person.spec.profile.understanding; $('person-corrections').value = person.spec.profile.corrections;
    $('person-identities').replaceChildren(); person.spec.identities.forEach(identityRow);
    $('person-updated').textContent = person.status.updatedAt ? '最近更新：' + new Date(person.status.updatedAt).toLocaleString() : '';
    $('person-notice').textContent = ''; history.replaceState(null, '', '/people?person=' + encodeURIComponent(id)); renderList();
  } catch (error) { $('person-notice').textContent = error.message; }
}
$('person-search').oninput = renderList;
$('person-editor').oninput = () => { dirty = true; };
$('identity-add').onclick = () => { identityRow(); dirty = true; };
$('person-reload').onclick = () => { if (!dirty || confirm('重新加载将放弃尚未保存的修改，继续？')) void select(selected.metadata.name); };
$('person-editor').onsubmit = async (event) => {
  event.preventDefault(); if (!selected) return; $('person-save').disabled = true;
  const spec = { name: $('person-name').value, profile: { understanding: $('person-understanding').value, corrections: $('person-corrections').value },
    identities: [...$('person-identities').children].map((row) => Object.fromEntries([...row.querySelectorAll('input')].map((input) => [input.dataset.key, input.value]))) };
  try {
    await request('/persons/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: selected.metadata.name, uid: selected.metadata.uid, version: selected.metadata.resourceVersion, spec }) });
    dirty = false; people = await request('/persons'); await select(selected.metadata.name); $('person-notice').textContent = '已保存。';
  } catch (error) { $('person-notice').textContent = error.message; }
  finally { $('person-save').disabled = false; }
};
window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
try { people = await request('/persons'); renderList(); const id = initialId || people.find((p) => p.isMe)?.metadata.name; if (id) await select(id); }
catch (error) { $('person-list-notice').textContent = error.message; }
