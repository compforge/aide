import './style.css';
import { byId as $, element as node } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import { updateMarkdown } from '../shared/markdown.ts';
import type { Addresses } from '../../../plugins/personal/address/service.ts';
import type { AddressRef } from '../../../plugins/personal/address/model.ts';
import type { Note } from '../../../plugins/personal/note/model.ts';
type View = ReturnType<Addresses['view']>;
type Page = ReturnType<Addresses['page']>;
let selected: View | undefined, continuation: string | undefined, noteContinue: string | undefined;
let notesLoading = false;
let busy = false, generation = 0, listGeneration = 0;
const types = { group: '群聊', direct: '私聊', web: 'Web', external: '外部系统' };
function currentRef(): AddressRef {
  if (!selected) throw new Error('请先选择地址');
  return { apiVersion: 'aide.dev/v1alpha1', kind: 'Address', namespace: 'v1', name: selected.metadata.name, uid: selected.metadata.uid };
}
function parameters(ref: AddressRef) { return new URLSearchParams({ name: ref.name, uid: ref.uid }); }
function report(error: unknown) { $('notice').textContent = errorMessage(error); }
function render(value: View) {
  selected = value; $('detail').hidden = false;
  $('heading').textContent = value.spec.name;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('#list a')) link.setAttribute('aria-current', String(new URL(link.href).searchParams.get('uid') === value.metadata.uid));
  $('coordinates').textContent = types[value.spec.type];
  $('state').textContent = value.spec.muted ? 'Aide 已禁言，仍可接收消息和积累认识。' : 'Aide 可以在此发言。';
  $('mute').textContent = value.spec.muted ? '解除禁言' : '禁言 Aide';
  updateMarkdown($('summary'), value.summaryText || '尚未积累长期认识。');
  $('people').replaceChildren(...value.participants.map(person => {
    const a = node('a', person.name + (person.clearance ? ` · ${person.clearance}` : ''));
    a.href = '/people?' + new URLSearchParams({ person: person.ref.name, uid: person.ref.uid }); return a;
  }));
}
function appendNotes(items: Note[]) {
  for (const note of items) {
    const card = node('article'), content = node('div', undefined, 'markdown');
    updateMarkdown(content, note.text); card.append(content, node('small', new Date(note.updatedAt).toLocaleString(), 'muted')); $('notes').append(card);
  }
}
async function loadNotes(reset = false) {
  if (notesLoading && !reset) return;
  notesLoading = true;
  const ref = currentRef(), turn = generation;
  const query = parameters(ref); if (!reset && noteContinue) query.set('continue', noteContinue);
  let result: { items: Note[]; continue?: string };
  try { result = await request('/addresses/notes?' + query); } finally { if (turn === generation) notesLoading = false; }
  if (turn !== generation) return;
  if (reset) $('notes').replaceChildren();
  appendNotes(result.items); noteContinue = result.continue; $('notes-more').hidden = !noteContinue;
}
async function select(ref: AddressRef) {
  if (busy) return;
  if (!$('editor').hidden && !confirm('放弃尚未保存的修改？')) return;
  const turn = ++generation;
  const value = await request<View>('/addresses/detail?' + parameters(ref));
  if (turn !== generation) return;
  $('notice').textContent = ''; $('editor').hidden = true; $('summary').hidden = false; render(value);
  history.replaceState(null, '', '/addresses?' + parameters(ref));
  await loadNotes(true);
}
async function list(reset = false) {
  const turn = ++listGeneration;
  const page = await request<Page>('/addresses/list' + (!reset && continuation ? '?' + new URLSearchParams({ continue: continuation }) : ''));
  if (turn !== listGeneration) return;
  if (reset) $('list').replaceChildren();
  for (const item of page.items) {
    const link = node('a', undefined, 'list-link'); link.href = '/addresses?' + parameters(item.ref);
    link.setAttribute('aria-current', String(item.ref.uid === selected?.metadata.uid));
    link.append(node('strong', item.name), node('span', `${types[item.type]} · ${item.muted ? '已禁言' : '可发言'}`, 'muted'));
    link.onclick = event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return; event.preventDefault(); void select(item.ref).catch(report); };
    $('list').append(link);
  }
  continuation = page.continue; $('more').hidden = !continuation;
}
async function save(path: string, value: object) {
  busy = true; $<HTMLButtonElement>('mute').disabled = true; $<HTMLButtonElement>('save').disabled = true;
  try {
    const updated = await request<View>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: currentRef(), ...value }) });
    render(updated); $('notice').textContent = '已保存'; await list(true); return true;
  } catch (error) { report(error); return false; }
  finally { busy = false; $<HTMLButtonElement>('mute').disabled = false; $<HTMLButtonElement>('save').disabled = false; }
}
$('mute').onclick = () => { if (selected && !busy) void save('/addresses/muted', { muted: !selected.spec.muted, expected: selected.spec.muted }); };
$('edit').onclick = () => { if (!selected) return; $<HTMLTextAreaElement>('text').value = selected.summaryText; $('editor').hidden = false; $('summary').hidden = true; $('text').focus(); };
$('cancel').onclick = () => { if (busy) return; $('editor').hidden = true; $('summary').hidden = false; };
$('editor').onsubmit = async event => { event.preventDefault(); if (!selected || busy) return; if (await save('/addresses/summary', { text: $<HTMLTextAreaElement>('text').value, version: selected.summaryVersion })) { $('editor').hidden = true; $('summary').hidden = false; } };
const tabs = ['summary', 'notes', 'people'];
function tab(name: string) { for (const key of tabs) { const active = key === name; $('tab-' + key).setAttribute('aria-selected', String(active)); $('tab-' + key).tabIndex = active ? 0 : -1; $('panel-' + key).hidden = !active; } }
for (const [index, name] of tabs.entries()) {
  $('tab-' + name).onclick = () => tab(name);
  $('tab-' + name).onkeydown = event => { const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : -1; if (next >= 0) { event.preventDefault(); tab(tabs[next]!); $('tab-' + tabs[next]).focus(); } };
}
$('more').onclick = () => { void list().catch(report); };
$('refresh').onclick = () => { void (async () => { await list(true); if (selected) await select(currentRef()); })().catch(report); };
$('notes-more').onclick = () => { void loadNotes().catch(report); };
void list(true).then(async () => { const q = new URLSearchParams(location.search); if (q.get('name') && q.get('uid')) await select({ apiVersion: 'aide.dev/v1alpha1', kind: 'Address', namespace: 'v1', name: q.get('name')!, uid: q.get('uid')! }); }).catch(report);
