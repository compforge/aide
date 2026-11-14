import { preserveTranscriptPosition } from './scroll.ts';
import { byId as $, element } from '../shared/dom.ts';
import { updateMarkdown } from '../shared/markdown.ts';
import { request, errorMessage } from '../shared/http.ts';
import { createProcessPane, executionLabel, executionDuration } from './process.ts';
import type { TopicBlock, TopicView } from '../../channel/view.ts';

/**
 * @spec Main conversation contains Input/Output bodies; process detail is read only in the shared right pane.
 * @spec Visible history loads ten identities at a time and at most three bodies concurrently; completed bodies are cached by resource version.
 * @link docs/channel/web.md#实时进展与历史
 */
export function createTimeline(topicId: string | null, signal: AbortSignal) {
  const pane = createProcessPane(topicId, signal);
  const rows = new Map<string, { version: string; node: HTMLElement }>();
  const queue: (() => Promise<void>)[] = [];
  let requests = 0, topicUid = '', linked = false;
  function pump() {
    while (requests < 3 && queue.length && !signal.aborted) {
      requests++; void queue.shift()!().finally(() => { requests--; pump(); });
    }
  }
  signal.addEventListener('abort', () => { queue.length = 0; }, { once: true });
  function processButton(id: string, text: string, phase?: string) {
    const state = phase && ['running', 'queued', 'completed', 'failed', 'cancelled', 'uncertain'].includes(phase) ? executionLabel(phase) + ' · ' : '';
    const button = element('button', state + '查看过程 →', 'process-link'); button.type = 'button';
    button.setAttribute('aria-controls', 'process-pane');
    button.addEventListener('click', () => pane.open(id, topicUid, text, button)); return button;
  }
  function message(block: TopicBlock) {
    const node = element('article', undefined, 'message ' + (block.type === 'input' ? block.role === 'user' ? 'user' : 'source' : 'aide'));
    node.dataset.scrollKey = block.id;
    const header = element('div', undefined, 'message-heading');
    header.append(element('strong', block.type === 'input' ? block.role === 'user' ? '你' : block.label || '观察' : 'Aide'));
    if (block.at) header.append(element('time', new Date(block.at).toLocaleString(), 'muted'));
    if (block.group_id && (block.type === 'message' || block.group_id !== block.inputId)) header.append(processButton(block.group_id, block.content, block.type === 'message' && !block.lazy ? block.status : undefined));
    const body = element('div', undefined, 'markdown message-body'); updateMarkdown(body, block.content || (block.generation === 'open' ? '正在准备回答…' : '暂无正文。'));
    node.append(header, body);
    if (block.generation === 'failed') node.append(element('p', '这次回答已中断，请核对后重新交办。', 'error'));
    if (block.type === 'message' && block.label) node.append(element('p', block.label, 'delivery-status'));
    const details = element('details', undefined, 'message-metadata'); details.append(element('summary', '消息详情'));
    details.append(element('code', block.id));
    if (block.detail) details.append(element('p', block.detail));
    if (block.origin) details.append(element('p', [block.origin, block.label].filter(Boolean).join(' · ')));
    if (block.sender) {
      const sender = element('a', '人物资料'); sender.href = '/people?' + new URLSearchParams({ person: block.sender.name, ...(block.sender.uid ? { uid: block.sender.uid } : {}) }); details.append(sender);
    }
    if (block.inputId) {
      const link = element('a', '输入处理记录'); link.href = '/inputs?' + new URLSearchParams({ input: block.inputId }); details.append(link);
    }
    node.append(details); return node;
  }
  function row(block: TopicBlock) {
    const version = JSON.stringify(block), saved = rows.get(block.id);
    if (saved?.version === version) return saved.node;
    const node = message(block), entry = { version, node }; rows.set(block.id, entry);
    if (block.lazy && topicId) {
      const identity = block.lazy;
      node.classList.add('loading-message');
      let failure: HTMLElement | undefined;
      async function load() {
        if (signal.aborted || rows.get(block.id) !== entry) return;
        failure?.remove();
        try {
          const view = await request<TopicView>('/topics/message?' + new URLSearchParams({ topicId: topicId!, topicUid: identity.topicUid, id: block.id, uid: identity.uid }), { signal });
          if (signal.aborted || rows.get(block.id) !== entry) return;
          const full = view.blocks.find(item => item.id === block.id);
          if (!full) throw new Error('消息已回收。');
          preserveTranscriptPosition($('messages'), () => {
            const rendered = message(full); node.className = rendered.className; node.replaceChildren(...rendered.childNodes);
          });
        } catch (error) {
          if (signal.aborted || rows.get(block.id) !== entry) return;
          const retry = element('button', '重试正文'); retry.type = 'button';
          retry.addEventListener('click', () => { retry.remove(); queue.push(load); pump(); }, { once: true });
          failure = element('div'); failure.append(element('p', errorMessage(error), 'error'), retry); node.append(failure);
        }
      }
      queue.push(load);
    }
    return node;
  }
  function render(view: TopicView, preservePosition = false) {
    topicUid = view.meta.topic_uid ?? view.blocks.find(b => b.lazy)?.lazy?.topicUid ?? topicUid;
    preserveTranscriptPosition($('messages'), () => {
      const messages = view.blocks.filter(b => b.type === 'input' || b.type === 'message' || b.type === 'summary');
      $('history').replaceChildren(...messages.map(row));
      if (!messages.length) $('history').append(element('p', '从一件具体的事开始，向 Aide 提问或交代事情。', 'empty'));
      const activity = view.meta.activity, area = $('activity');
      const executions = view.blocks.filter(b => b.type === 'execution');
      area.hidden = !activity;
      if (activity) {
        const active = executions.filter(b => b.status === 'running' || b.status === 'queued');
        const header = element('div', undefined, 'activity-heading');
        header.append(element('span', 'Aide · ' + executionLabel(activity.phase) + (activity.queued ? ` · ${activity.queued} 条待处理` : '')));
        for (const run of active) if (run.group_id) header.append(processButton(run.group_id, '当前执行'));
        if (!active.length && !activity.id.startsWith('queued:')) header.append(processButton(activity.id, '当前执行'));
        area.replaceChildren(header);
        if (activity.error) area.append(element('p', activity.error, 'error'));
        area.dataset.phase = activity.phase;
      }
      // A completed execution without an Output still has a visible status and process entry.
      for (const run of executions) if (run.status !== 'running' && run.status !== 'queued' && !messages.some(b => b.type === 'message' && b.group_id === run.group_id)) {
        const status = element('div', undefined, 'execution-status');
        status.append(element('span', `Aide · ${executionLabel(run.status)}${executionDuration(run)}`));
        if (run.group_id) status.append(processButton(run.group_id, '执行记录'));
        if (run.detail) status.append(element('p', run.detail, 'error'));
        $('history').append(status);
      }
    }, preservePosition);
    pump();
    if (!linked && topicUid) {
      linked = true;
      const url = new URL(location.href), id = url.searchParams.get('process');
      if (id) pane.open(id, url.searchParams.get('processTopicUid') || topicUid, '所选执行');
    }
  }
  return { render, pause: pane.pause, show: pane.show };
}
