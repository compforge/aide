import { byId as $, element, find } from '../shared/dom.ts';
import { updateMarkdown } from '../shared/markdown.ts';
import { historyBlocks, replyText, processPreview, replyLabels, toolLabels } from '../../channel/reply-layout.ts';
import type { ConversationBlock, ConversationView } from '../../channel/view.ts';
type LiveActivity = NonNullable<ConversationView['meta']['activity']> & {
  harnesses: ConversationBlock[]; answers: string[];
  blocks: (ConversationBlock & { kind: string; text: string })[];
};
const inputLabels: Record<string, string> = { queued: '待处理', running: '处理中', done: '已处理', quiet: '已查看 · 保持安静', failed: '处理失败' };

export function createTimeline() {
  let lastMessages = '';
  function identityBadge(drawing: string | undefined, label: string | undefined) {
    const badge = element('span', undefined, 'identity-badge'); badge.title = label ?? '';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.classList.add('identity-icon'); icon.setAttribute('aria-hidden', 'true');
    for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) icon.setAttribute(name, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', drawing ?? ''); icon.append(path);
    badge.append(icon, element('span', label)); return badge;
  }
  function replyHeading(node: HTMLElement, title: string, executions: ConversationBlock[]) {
    const heading = find(node, 'summary'); heading.replaceChildren(element('span', title));
    const harnesses = new Map(executions.filter((block) => block.harness).map((block) => [block.harness, block]));
    for (const block of harnesses.values()) heading.append(identityBadge(block.icon, block.label));
  }
  function receivedInput(block: ConversationBlock) {
    const source = block.origin === 'source';
    const summary = block.type === 'summary';
    const node = element('article', undefined, 'message received-input ' + (source || summary ? 'source' : 'user'));
    if (block.inputId) node.dataset.inputId = block.inputId;
    const header = element('div', undefined, 'input-heading');
    header.append(identityBadge(block.icon, summary ? block.label : (source ? 'Source' : 'Channel') + (block.label ? ' · ' + block.label : '') + (block.relation === 'sent' ? ' · 你' : '')));
    if (block.sender?.name) {
      const sender = element('a', '人物资料');
      sender.href = '/people?' + new URLSearchParams({ person: block.sender.name, ...(block.sender.uid ? { uid: block.sender.uid } : {}) });
      header.append(sender);
    }
    if (!summary) header.append(element('time', new Date(block.at!).toLocaleString(), 'input-time'));
    if (source) header.append(element('span', inputLabels[block.status ?? ''] || block.status, 'input-status'));
    const body = element('div', undefined, 'markdown message-body'); updateMarkdown(body, block.content);
    node.append(header, body);
    if (block.detail) {
      const details = replyRegion('input:' + block.inputId + ':evidence', '输入详情', false);
      details.className = 'input-evidence reply-region';
      if (block.detail) details.append(element('pre', block.detail));
      node.append(details);
    }
    return node;
  }
  const regionChoices = new Map<string, boolean>();
  function replyRegion(id: string, title: string, defaultOpen: boolean) {
    const node = element('details', undefined, 'reply-region');
    node.dataset.blockId = id; node.open = regionChoices.get(id) ?? defaultOpen;
    const summary = element('summary', title);
    summary.addEventListener('click', () => {
      regionChoices.set(id, !node.open);
      if (node.dataset.phase) node.dataset.state = !node.open ? 'full' : isLive(node.dataset.phase) ? 'live' : 'compact';
      if (node.dataset.kind === 'answer' && isLive(node.dataset.phase)) requestAnimationFrame(() => {
        const preview = find(node, '.reply-preview'); preview.scrollTop = preview.scrollHeight;
      });
    });
    node.append(summary); return node;
  }
  const isLive = (phase: string | undefined) => phase === 'running' || phase === 'queued';
  /** @spec Execution phase and reader expansion are independent; streaming and completion preserve explicit choices. */
  function replyPart(id: string, title: string, phase: string, kind: string) {
    const node = replyRegion(id, '', kind === 'answer' && phase === 'failed');
    node.dataset.kind = kind; node.dataset.title = title;
    const summary = find(node, 'summary');
    summary.append(element('span', title, 'reply-part-title'), element('span', '', 'reply-toggle'), element('div', '', 'reply-preview'));
    node.classList.add('reply-part');
    updatePart(node, phase, []);
    return node;
  }
  function updatePart(node: HTMLDetailsElement, phase: string, lines: string[]) {
    node.dataset.phase = phase;
    node.dataset.state = node.open ? 'full' : isLive(phase) ? 'live' : 'compact';
    const preview = find(node, '.reply-preview');
    const signature = JSON.stringify(lines);
    if (preview.dataset.signature !== signature) {
      preview.dataset.signature = signature;
      preview.replaceChildren(...lines.map((line) => element('span', line, 'reply-preview-line')));
    }
    find(node, '.reply-part-title').textContent = node.dataset.title + ' · ' + (replyLabels[phase] || phase);
    if (isLive(phase) && node.dataset.kind === 'answer') preview.scrollTop = preview.scrollHeight;
  }
  function updateAnswer(node: HTMLDetailsElement, phase: string, answer: string) {
    if (!regionChoices.has(node.dataset.blockId!)) node.open = phase === 'failed';
    updatePart(node, phase, [answer.trim() ? replyText(answer) : phase === 'failed' ? '本次处理已中断，请核对后重新交办。' : phase === 'done' ? '回复已完成' : '等待生成回答…']);
    updateMarkdown(find(node, '.message-body'), answer || (phase === 'failed' ? '本次处理已中断，请核对后重新交办。' : '等待生成回答…'));
  }
  function updateProcess(node: HTMLDetailsElement, phase: string, blocks: { type: string; content: string; status?: string }[]) {
    const preview = processPreview(phase, blocks);
    updatePart(node, phase, isLive(phase) ? ['思考：' + preview.thought, '工具：' + preview.tool] : [preview.summary]);
  }
  function appendProgress(parent: HTMLElement, blocks: ConversationBlock[], expanded: Map<string | undefined, boolean>) {
    for (const block of blocks) {
      const node = progressNode(block.type); node.dataset.blockId = block.id;
      if (node instanceof HTMLDetailsElement) node.open = expanded.get(block.id) ?? true;
      updateProgress(node, block.type, block.content, block.status, block.detail);
      parent.append(node);
    }
  }
  /** @spec Each Input renders one collapsible reply with independently collapsible process and answer regions; final text appears once. */
  function renderMessages(blocks: ConversationBlock[], activity: ConversationView["meta"]["activity"]) {
    const history = historyBlocks(blocks, activity);
    const signature = JSON.stringify(history);
    if (signature === lastMessages) return;
    lastMessages = signature;
    const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 100;
    const expanded = new Map([...$('messages').querySelectorAll('details')].map((node) => [node.dataset.blockId, node.open]));
    $('history').replaceChildren();
    if (!history.length) {
      const empty = element('div', undefined, 'empty');
      empty.append(element('h2', '从一件具体的事开始'), element('p', '例如：总结工作目录里的 README；每天上午检查项目进展；关注某件事，发生变化时告诉我。'));
      $('history').append(empty);
    }
    const rendered = new Set();
    const roots = history.filter((block) => !block.parent_id);
    for (const block of roots) {
      if (block.type === 'input' || block.type === 'summary') {
        $('history').append(receivedInput(block)); continue;
      }
      const groupId = block.group_id || block.id;
      if (rendered.has(groupId)) continue;
      rendered.add(groupId);
      const group = block.group_id ? roots.filter((item) => item.group_id === block.group_id) : [block];
      const executions = new Set(group.filter((item) => item.type === 'execution').map((item) => item.id));
      const children = history.filter((item) => executions.has(item.parent_id ?? ''));
      const answers = group.filter((item) => item.type === 'message' && item.role === 'aide').map((item) => item.content);
      const answer = answers.join('\n\n');
      const process = children.filter((item) => item.type !== 'text' || !answers.includes(item.content));
      const failed = group.some((item) => item.status === 'failed' || item.status === 'interrupted');
      const phase = failed ? 'failed' : 'done';
      const title = 'Aide · ' + replyLabels[phase];
      const node = replyRegion('input:' + groupId + ':whole', title, true);
      node.className = 'message aide assistant-reply reply-envelope'; node.dataset.inputId = groupId;
      replyHeading(node, title, group.filter((item) => item.type === 'execution'));
      if (executions.size || block.group_id || process.length) {
        const thought = replyPart('input:' + groupId + ':think', '过程', phase, 'process');
        updateProcess(thought, phase, process);
        appendProgress(thought, process, expanded);
        if (!process.length) thought.append(element('p', '没有可展示的思考或工具记录。', 'muted'));
        node.append(thought);
      }
      if (answer) {
        const reply = replyPart('input:' + groupId + ':answer', '回答', phase, 'answer');
        const body = element('div', undefined, 'markdown message-body'); updateMarkdown(body, answer);
        reply.append(body); updateAnswer(reply, phase, answer); node.append(reply);
      }
      $('history').append(node);
    }
    if (nearBottom) $('messages').scrollTop = $('messages').scrollHeight;
  }
  let activityId: string | undefined;
  const activityNodes = new Map<string, HTMLElement>();
  function progressNode(kind: string) {
    const node = element(kind === 'text' ? 'div' : 'details', undefined, 'activity-block ' + kind);
    if (node instanceof HTMLDetailsElement) { node.open = true; node.append(element('summary')); }
    node.append(element('div', '', 'activity-content')); return node;
  }
  function updateProgress(node: HTMLElement, kind: string, text: string, status?: string, detail?: string) {
    if (kind === 'thought') find(node, 'summary').textContent = '思考过程';
    if (kind === 'tool') find(node, 'summary').textContent = text + ' · ' + (toolLabels[status ?? ''] || status || '状态未知');
    const content = find(node, '.activity-content');
    const value = kind === 'tool' ? detail || '' : text;
    if (kind === 'tool') {
      if (content.textContent !== value) content.textContent = value;
    } else {
      content.classList.add('markdown'); updateMarkdown(content, value);
    }
  }
  function renderActivity(activity: LiveActivity | null) {
    const area = $('activity');
    const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 100;
    area.hidden = !activity;
    if (!activity) { area.replaceChildren(); activityNodes.clear(); activityId = undefined; return; }
    if (activity.id !== activityId) {
      activityId = activity.id; activityNodes.clear(); area.replaceChildren();
      const envelope = replyRegion('input:' + activity.id + ':whole', 'Aide · 正在处理', true); envelope.className = 'reply-envelope';
      const heading = find(envelope, 'summary'); heading.id = 'activity-heading'; heading.className = 'activity-heading'; heading.setAttribute('role', 'status');
      const thought = replyPart('input:' + activity.id + ':think', '过程', activity.phase, 'process'); thought.id = 'activity-thought';
      const reply = replyPart('input:' + activity.id + ':answer', '回答', activity.phase, 'answer');
      const body = element('div', undefined, 'markdown message-body'); body.id = 'activity-answer'; reply.append(body);
      envelope.append(thought, reply); area.append(envelope);
    }
    const last = activity.blocks.at(-1);
    const label = activity.phase === 'queued' ? '正在排队'
      : last?.kind === 'tool' && last.status === 'in_progress' ? '正在调用工具'
      : last?.kind === 'thought' ? '正在思考' : last?.kind === 'text' ? '正在回复' : '正在处理';
    replyHeading(find(area, '.reply-envelope'), 'Aide · ' + label + '…' + (activity.queued ? ` · ${activity.queued} 条待处理` : ''), activity.harnesses);
    const answer = activity.answers.join('\n\n');
    updateAnswer($('activity-answer').parentElement as HTMLDetailsElement, activity.phase, answer);
    const process = activity.blocks.filter((block) => block.kind !== 'text' ||
      !activity.answers.includes(block.text));
    updateProcess($<HTMLDetailsElement>('activity-thought'), activity.phase, process.map((block) => ({ type: block.kind, content: block.text, status: block.status })));
    const ids = new Set(process.map((block) => block.id));
    for (const [id, node] of activityNodes) if (!ids.has(id)) { node.remove(); activityNodes.delete(id); }
    for (const block of process) {
      let node = activityNodes.get(block.id);
      if (!node) { node = progressNode(block.kind); activityNodes.set(block.id, node); $('activity-thought').append(node); }
      updateProgress(node, block.kind, block.text, block.status, block.detail);
    }
    if (nearBottom) $('messages').scrollTop = $('messages').scrollHeight;
  }

  function render(view: ConversationView) {
    renderMessages(view.blocks, view.meta.activity);
    const activity = view.meta.activity;
    const liveIds = new Set(view.blocks.filter((block) => block.type === 'execution' &&
      (block.status === 'running' || (activity && block.group_id === activity.id))).map((block) => block.id));
    renderActivity(activity && { ...activity,
      harnesses: view.blocks.filter((block) => block.type === 'execution' && liveIds.has(block.id)),
      answers: view.blocks.filter((block) => block.type === 'message' && block.role === 'aide' && block.group_id === activity.id).map((block) => block.content),
      blocks: view.blocks.filter((block) => liveIds.has(block.parent_id ?? ''))
        .map((block) => ({ ...block, kind: block.type, text: block.content })) });
  }
  return { render };
}
