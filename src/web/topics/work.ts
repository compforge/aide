import { byId as $, element } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import { copyText } from '../shared/clipboard.ts';
import type { Work } from '../../../plugins/personal/model.ts';
const labels: Record<Work['status'], string> = { ready: '准备执行', running: '执行中', waiting: '等你回答', scheduled: '等待触发', paused: '已暂停', done: '已完成', uncertain: '需要核对结果', invalid_result: '结果解析失败' };

export function createWorkPanel(topicId: string, onChange: () => Promise<void>, signal: AbortSignal) {
  let lastWork = '';
  const deletingWork = new Set<string>();
  const expanded = new Map<string, boolean>();
  function renderWork(works: Work[]) {
    const signature = JSON.stringify(works);
    if (signature === lastWork) return;
    lastWork = signature;
    renderWorkGroup(works.filter((work) => work.kind === 'task'), 'tasks', 'task-count', '还没有事项，交办一件事试试。');
    renderWorkGroup(works.filter((work) => work.kind === 'routine'), 'routines', 'routine-count', '还没有安排，可以告诉我想定期处理或长期关注什么。');
  }
  function renderWorkGroup(works: Work[], listId: string, countId: string, emptyText: string) {
    $(countId).textContent = String(works.length);
    const attention = works.filter((work) => ['waiting', 'uncertain', 'invalid_result'].includes(work.status)).length;
    const tab = $('tab-' + listId);
    tab.classList.toggle('needs-attention', attention > 0);
    tab.title = attention ? `${attention} 项需要你处理` : '';
    tab.setAttribute('aria-label', `${listId === 'tasks' ? '事项' : '安排'} ${works.length}${attention ? `，${attention} 项需要你处理` : ''}`);
    const list = $(listId);
    list.replaceChildren();
    if (!works.length) list.append(element('p', emptyText, 'muted'));
    for (const work of [...works].reverse()) {
      const node = element('article', undefined, 'work');
      const header = element('div', undefined, 'work-header');
      const actions = element('div', undefined, 'work-actions');
      const copy = element('button', '复制 ID', 'work-copy');
      copy.type = 'button'; copy.title = work.id;
      copy.setAttribute('aria-label', '复制' + (work.kind === 'task' ? '事项' : '安排') + ' ID：' + work.title);
      copy.setAttribute('aria-live', 'polite');
      copy.addEventListener('click', async () => {
        copy.disabled = true;
        $('work-notice').className = 'muted'; $('work-notice').textContent = '';
        try {
          await copyText(work.id);
          if (signal.aborted) return;
          copy.textContent = '已复制';
        } catch {
          if (signal.aborted) return;
          copy.disabled = false;
          $('work-notice').className = 'error';
          $('work-notice').textContent = '复制失败，请手动复制 ID：' + work.id;
          return;
        }
        setTimeout(() => { copy.textContent = '复制 ID'; copy.disabled = false; }, 1500);
      });
      const remove = element('button', deletingWork.has(work.id) ? '删除中…' : '删除', 'work-delete');
      remove.type = 'button';
      remove.setAttribute('aria-label', '删除' + (work.kind === 'task' ? '事项：' : '安排：') + work.title);
      remove.disabled = deletingWork.has(work.id);
      remove.addEventListener('click', async () => {
        if (deletingWork.has(work.id) || !confirm('删除「' + work.title + '」？\n删除后停止后续跟进，已有消息会保留。已发起的操作可能仍会完成。')) return;
        deletingWork.add(work.id); remove.disabled = true; remove.textContent = '删除中…';
        $('work-notice').className = 'muted'; $('work-notice').textContent = '';
        try {
          await request('/work/delete', { method: 'POST', signal, headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: work.id, topicId, revision: work.revision }) });
          if (signal.aborted) return;
          $('work-notice').textContent = '已删除「' + work.title + '」。';
        } catch (error) {
          if (signal.aborted) return;
          $('work-notice').className = 'error'; $('work-notice').textContent = errorMessage(error);
        } finally {
          deletingWork.delete(work.id); remove.disabled = false; remove.textContent = '删除';
          if (!signal.aborted) await onChange();
        }
      });
      actions.append(copy, remove);
      header.append(element('span', labels[work.status], 'badge ' + work.status), actions);
      node.append(header, element('strong', work.title));
      if (work.question) node.append(element('p', work.question));
      if (work.status === 'uncertain') node.append(element('p', '执行中断或失败。请核对外部结果，再发消息决定是否继续。'));
      if (work.status === 'invalid_result') node.append(element('p', '执行已结束，但最终结果解析失败。请核对执行记录，再决定是否继续。'));
      if (work.nextAt) node.append(element('p', '下次：' + new Date(work.nextAt).toLocaleString(), 'muted'));
      const detail = element('details');
      detail.open = expanded.get(work.id) ?? false;
      detail.addEventListener('toggle', () => {
        if (detail.isConnected && !signal.aborted) expanded.set(work.id, detail.open);
      });
      detail.append(element('summary', '查看目标与进展'), element('p', work.instruction));
      const latest = work.recent.at(-1);
      if (work.lastReport) detail.append(element('p', '最近办理：' + work.lastReport.text));
      if (latest) detail.append(element('p', '近期事项：' + latest.text));
      node.append(detail); list.append(node);
    }
  }
  return { render: renderWork };
}
