import type { PersonView, PersonItem, PersonListView } from '../../api/types.ts';
import { mergePersonSummary } from '../../../plugins/personal/person/merge.ts';
import { byId as $, element as node } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';

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
  private candidates?: AbortController;
  private candidateKey = '';
  private candidatePage = 1;
  pause() { this.candidates?.abort(); }
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
  async render() {
    const current = this.actions.current();
    const key = JSON.stringify([current.metadata.uid, current.spec.name]);
    if (key !== this.candidateKey) { this.candidateKey = key; this.candidatePage = 1; }
    this.candidates?.abort(); const controller = new AbortController(); this.candidates = controller;
    try {
      const result = await request<PersonListView>('/persons?' + new URLSearchParams({ name: current.spec.name,
        excludeUid: current.metadata.uid, page: String(this.candidatePage), pageSize: '10' }), { signal: controller.signal });
      if (controller.signal.aborted) return;
      this.candidatePage = result.page;
      const candidates = [...result.pinned, ...result.items];
      $('person-same-names').hidden = !candidates.length;
      $('person-same-name-list').replaceChildren();
      for (const person of candidates) {
        const item = node('article', undefined, 'person-candidate');
        item.append(node('strong', person.name + (person.isMe ? ' · 我' : '')), node('p', person.preview || '尚未积累认识。'));
        const button = node('button', '核对并合并', 'secondary'); button.type = 'button';
        button.title = '核对双方身份后合并到当前人物';
        button.onclick = () => { void this.open(person); };
        item.append(button); $('person-same-name-list').append(item);
      }
      if (result.pages > 1) {
        const controls = node('div');
        for (const [label, delta] of [['上一页', -1], ['下一页', 1]] as const) {
          const button = node('button', label, 'secondary'); button.type = 'button';
          button.disabled = delta < 0 ? result.page <= 1 : result.page >= result.pages;
          button.onclick = () => { this.candidatePage += delta; void this.render(); }; controls.append(button);
        }
        controls.append(node('span', ` ${result.page} / ${result.pages}`)); $('person-same-name-list').append(controls);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        $('person-same-names').hidden = false;
        $('person-same-name-list').replaceChildren(node('p', '同名人物查询失败：' + errorMessage(error)));
      }
    }
  }
  private async open(candidate: PersonItem) {
    if (this.actions.hasUnsavedChanges()) {
      $('person-notice').textContent = '请先保存或取消当前修改，再合并人物。'; return;
    }
    this.actions.busy(true);
    try {
      const current = this.actions.current();
      const read = (p: PersonView) => request<PersonView>('/persons?' + new URLSearchParams({ id: p.metadata.name, uid: p.metadata.uid }));
      const [source, target] = await Promise.all([request<PersonView>('/persons?' + new URLSearchParams({ id: candidate.id, uid: candidate.uid })), read(current)]);
      if (target.metadata.resourceVersion !== current.metadata.resourceVersion) throw new Error('当前人物资料已更新，请重新加载后合并。');
      this.source = source; this.target = target;
      for (const [id, person] of [['person-merge-source', source], ['person-merge-target', target]] as const) {
        $(id).replaceChildren(node('strong', person.spec.name + (person.isMe ? ' · 我' : '')), identityDetails(person), node('p', person.summaryText || '尚未积累认识。'));
      }
      $<HTMLTextAreaElement>('person-merge-summary').value = mergePersonSummary(target.summaryText, source.summaryText);
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
