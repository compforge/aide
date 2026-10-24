import type { PersonView } from '../../api/types.ts';
import { mergePersonSummary } from '../../../plugins/personal/person/merge.ts';
import { byId as $, element as node } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';

export function sameNamedPersons(people: readonly PersonView[], current: PersonView) {
  return people.filter((p) => p.metadata.uid !== current.metadata.uid && !p.metadata.deletionTimestamp && p.spec.name === current.spec.name);
}

function identityDetails(person: PersonView) {
  const list = node('ul', undefined, 'person-merge-identities');
  for (const identity of person.spec.identities) list.append(node('li', `${identity.provider} · ${identity.scope} · ${identity.id}`));
  if (!list.children.length) list.append(node('li', '尚未绑定外部身份'));
  return list;
}
const version = (person: PersonView) => ({ id: person.metadata.name, uid: person.metadata.uid, version: person.metadata.resourceVersion });

/** The dialog owns the reviewed snapshots; confirmation never silently refreshes a changed profile. */
export class PersonMerge {
  private source?: PersonView;
  private target?: PersonView;
  private submitting = false;
  private dialog = $<HTMLDialogElement>('person-merge-dialog');
  constructor(private readonly actions: {
    current(): PersonView;
    hasUnsavedChanges(): boolean;
    busy(value: boolean): void;
    merged(source: PersonView, target: PersonView): void;
  }) {
    $('person-merge-cancel').onclick = () => this.dialog.close();
    this.dialog.oncancel = (event) => { if (this.submitting) event.preventDefault(); };
    this.dialog.onclose = () => { this.source = this.target = undefined; this.actions.busy(false); };
    $('person-merge-form').onsubmit = (event) => { event.preventDefault(); void this.confirm(); };
  }
  render(people: readonly PersonView[]) {
    const current = this.actions.current();
    const candidates = sameNamedPersons(people, current);
    $('person-same-names').hidden = !candidates.length;
    $('person-same-name-list').replaceChildren();
    for (const person of candidates) {
      const item = node('article', undefined, 'person-candidate');
      item.append(identityDetails(person));
      const button = node('button', '合并', 'secondary'); button.type = 'button';
      button.title = '合并到当前人物';
      button.onclick = () => { void this.open(person); };
      item.append(button); $('person-same-name-list').append(item);
    }
  }
  private async open(candidate: PersonView) {
    if (this.actions.hasUnsavedChanges()) {
      $('person-notice').textContent = '请先保存或取消当前修改，再合并人物。'; return;
    }
    this.actions.busy(true);
    try {
      const current = this.actions.current();
      const read = (p: PersonView) => request<PersonView>('/persons?' + new URLSearchParams({ id: p.metadata.name, uid: p.metadata.uid }));
      const [source, target] = await Promise.all([read(candidate), read(current)]);
      if (target.metadata.resourceVersion !== current.metadata.resourceVersion) throw new Error('当前人物资料已更新，请重新加载后合并。');
      this.source = source; this.target = target;
      for (const [id, person] of [['person-merge-source', source], ['person-merge-target', target]] as const) {
        $(id).replaceChildren(node('strong', person.spec.name + (person.isMe ? ' · 我' : '')), identityDetails(person), node('p', person.status.summary || '尚未积累认识。'));
      }
      $<HTMLTextAreaElement>('person-merge-summary').value = mergePersonSummary(target.status.summary, source.status.summary);
      $('person-merge-notice').textContent = '';
      this.dialog.showModal();
    } catch (error) { $('person-notice').textContent = errorMessage(error); this.actions.busy(false); }
  }
  private async confirm() {
    if (this.submitting || !this.source || !this.target) return;
    const summary = $<HTMLTextAreaElement>('person-merge-summary').value;
    if (summary.length > 16000) { $('person-merge-notice').textContent = '合并后的认识超过 16000 字符，请精简后确认。'; return; }
    this.submitting = true;
    $<HTMLTextAreaElement>('person-merge-summary').readOnly = true;
    $<HTMLButtonElement>('person-merge-confirm').disabled = true;
    $<HTMLButtonElement>('person-merge-cancel').disabled = true;
    try {
      const merged = await request<PersonView>('/persons/merge', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: version(this.source), target: version(this.target), summary }) });
      this.actions.merged(this.source, merged);
      this.dialog.close();
    } catch (error) { $('person-merge-notice').textContent = errorMessage(error); }
    finally {
      this.submitting = false;
      $<HTMLTextAreaElement>('person-merge-summary').readOnly = false;
      $<HTMLButtonElement>('person-merge-confirm').disabled = false;
      $<HTMLButtonElement>('person-merge-cancel').disabled = false;
    }
  }
}
