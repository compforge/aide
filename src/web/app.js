import { applyPatch, parsePatchEvent, renderMarkdown, replyText, processPreview, replyLabels, toolLabels } from '/agentue.js';
  const $ = (id) => document.getElementById(id);
  const conversationId = new URL(location.href).searchParams.get('conversation') || 'me';
  const query = '?conversationId=' + encodeURIComponent(conversationId);
  const labels = { ready: '准备执行', running: '执行中', waiting: '等你回答', scheduled: '等待触发', paused: '已暂停', done: '已完成', uncertain: '需要核对结果', invalid_result: '结果解析失败' };
  let lastMessages = '', lastWork = '', lastInteractions = '', polling = false, sending = false, draft = null;
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  const markdownSources = new WeakMap();
  function updateMarkdown(node, source) {
    if (markdownSources.get(node) === source) return;
    node.innerHTML = renderMarkdown(source);
    markdownSources.set(node, source);
  }
  async function api(path, options) {
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '请求失败');
    return data;
  }
  let lastConversations = '';
  const heartbeatUpdates = new Set();
  function renderConversations(conversations) {
    const items = [...conversations];
    for (const id of new Set([conversationId, 'me'])) {
      if (!items.some((item) => item.id === id)) items.push({ id, title: id === 'me' ? '默认对话' : id, preview: '' });
    }
    const current = items.find((item) => item.id === conversationId);
    $('conversation-heading').textContent = current.title;
    $('conversation-id').textContent = current.id;
    document.title = current.title + ' · Aide';
    const signature = JSON.stringify(items);
    if (signature === lastConversations) return;
    lastConversations = signature;
    const links = items.map((item) => {
      const link = element('a', undefined, 'conversation-link');
      const url = new URL(location.href); url.searchParams.set('conversation', item.id);
      link.href = url.href;
      if (item.id === conversationId) link.setAttribute('aria-current', 'page');
      link.title = item.title + ' · ' + item.id;
      link.append(element('strong', item.title), element('span', item.id, 'muted'));
      if (item.preview) link.append(element('span', item.preview, 'muted'));
      const row = element('div', undefined, 'conversation-row'); row.append(link);
      if (item.sessionId) {
        const label = element('label', undefined, 'heartbeat-switch');
        const toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = item.heartbeat.enabled;
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-label', item.title + '：主动回顾');
        toggle.disabled = heartbeatUpdates.has(item.sessionId);
        label.title = '开启后定时回顾；关闭不影响已有事项与安排。';
        toggle.addEventListener('change', async () => {
          heartbeatUpdates.add(item.sessionId);
          for (const control of document.querySelectorAll('.heartbeat-switch input')) control.disabled = true;
          try {
            await api('/sessions/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: item.sessionId, conversationId: item.id, enabled: toggle.checked }) });
            $('conversation-notice').textContent = '';
          } catch (error) {
            toggle.checked = item.heartbeat.enabled;
            $('conversation-notice').textContent = '开关保存失败：' + error.message;
          } finally {
            heartbeatUpdates.delete(item.sessionId); lastConversations = '';
            try { renderConversations(await api('/conversations')); } catch { for (const control of document.querySelectorAll('.heartbeat-switch input')) control.disabled = false; }
          }
        });
        label.append(toggle, element('span', '主动回顾')); row.append(label);
      }
      return row;
    });
    $('conversation-list').replaceChildren(...links);
  }
  async function refreshConversations() {
    try {
      if (heartbeatUpdates.size) return;
      renderConversations(await api('/conversations'));
      $('conversation-notice').textContent = '';
    } catch { $('conversation-notice').textContent = '会话列表暂时无法更新，正在重试。'; }
  }
  const regionChoices = new Map();
  function replyRegion(id, title, defaultOpen) {
    const node = element('details', undefined, 'reply-region');
    node.dataset.blockId = id; node.open = regionChoices.get(id) ?? defaultOpen;
    const summary = element('summary', title);
    summary.addEventListener('click', () => {
      regionChoices.set(id, !node.open);
      if (node.dataset.phase) node.dataset.state = !node.open ? 'full' : isLive(node.dataset.phase) ? 'live' : 'compact';
      if (node.dataset.kind === 'answer' && isLive(node.dataset.phase)) requestAnimationFrame(() => {
        const preview = node.querySelector('.reply-preview'); preview.scrollTop = preview.scrollHeight;
      });
    });
    node.append(summary); return node;
  }
  const isLive = (phase) => phase === 'running' || phase === 'queued';
  /** @spec Execution phase and reader expansion are independent; streaming and completion preserve explicit choices. */
  function replyPart(id, title, phase, kind) {
    const node = replyRegion(id, '', kind === 'answer' && (phase === 'waiting' || phase === 'failed'));
    node.dataset.kind = kind; node.dataset.title = title;
    const summary = node.querySelector('summary');
    summary.append(element('span', title, 'reply-part-title'), element('span', '', 'reply-toggle'), element('div', '', 'reply-preview'));
    node.classList.add('reply-part');
    updatePart(node, phase, []);
    return node;
  }
  function updatePart(node, phase, lines) {
    node.dataset.phase = phase;
    node.dataset.state = node.open ? 'full' : isLive(phase) ? 'live' : 'compact';
    const preview = node.querySelector('.reply-preview');
    const signature = JSON.stringify(lines);
    if (preview.dataset.signature !== signature) {
      preview.dataset.signature = signature;
      preview.replaceChildren(...lines.map((line) => element('span', line, 'reply-preview-line')));
    }
    node.querySelector('.reply-part-title').textContent = node.dataset.title + ' · ' + (replyLabels[phase] || phase);
    if (isLive(phase) && node.dataset.kind === 'answer') preview.scrollTop = preview.scrollHeight;
  }
  function updateAnswer(node, phase, answer) {
    if (!regionChoices.has(node.dataset.blockId)) node.open = phase === 'waiting' || phase === 'failed';
    updatePart(node, phase, [answer.trim() ? replyText(answer) : phase === 'failed' ? '本次处理已中断，请核对后重新交办。' : phase === 'waiting' ? '等待你回答。' : phase === 'done' ? '回复已完成' : '等待生成回答…']);
    updateMarkdown(node.querySelector('.message-body'), answer || (phase === 'failed' ? '本次处理已中断，请核对后重新交办。' : phase === 'waiting' ? '等待你回答。' : '等待生成回答…'));
  }
  function updateProcess(node, phase, blocks) {
    const preview = processPreview(phase, blocks);
    updatePart(node, phase, isLive(phase) ? ['思考：' + preview.thought, '工具：' + preview.tool] : [preview.summary]);
  }
  function appendProgress(parent, blocks, expanded) {
    for (const block of blocks) {
      const node = progressNode(block.type); node.dataset.blockId = block.id;
      if (block.type !== 'text') node.open = expanded.get(block.id) ?? block.type !== 'question';
      updateProgress(node, block.type, block.content, block.status, block.detail);
      parent.append(node);
    }
  }
  /** @spec Each Input renders one collapsible reply with independently collapsible process and answer regions; final text appears once. */
  function renderMessages(blocks, activity) {
    const liveIds = new Set(blocks.filter((block) => block.type === 'execution' &&
      (block.status === 'running' || (activity && block.group_id === activity.id))).map((block) => block.id));
    const history = blocks.filter((block) => !liveIds.has(block.id) && !liveIds.has(block.parent_id) &&
      (!activity || block.group_id !== activity.id));
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
      if (block.type === 'message' && block.role === 'user') {
        const node = element('article', undefined, 'message user');
        const body = element('div', undefined, 'markdown message-body'); updateMarkdown(body, block.content);
        node.append(element('div', '你 · ' + new Date(block.at).toLocaleTimeString(), 'muted'), body);
        $('history').append(node); continue;
      }
      const groupId = block.group_id || block.id;
      if (rendered.has(groupId)) continue;
      rendered.add(groupId);
      const group = block.group_id ? roots.filter((item) => item.group_id === block.group_id) : [block];
      const executions = new Set(group.filter((item) => item.type === 'execution').map((item) => item.id));
      const children = history.filter((item) => executions.has(item.parent_id));
      const answers = group.filter((item) => item.type === 'message' && item.role === 'aide').map((item) => item.content);
      const lastText = children.filter((item) => item.type === 'text').at(-1);
      const questions = group.filter((item) => item.type === 'question');
      const pending = questions.filter((item) => item.status === 'pending');
      const answer = pending.map((item) => item.content).join('\n\n') || answers.join('\n\n') || lastText?.content || '';
      const process = children.filter((item) => item.type !== 'text' || (answers.length ? item.phase !== 'final' && !answers.includes(item.content) : item !== lastText))
        .concat(questions.filter((item) => item.status !== 'pending'));
      const failed = group.some((item) => item.status === 'failed' || item.status === 'interrupted');
      const phase = pending.length ? 'waiting' : failed ? 'failed' : 'done';
      const title = 'Aide · ' + replyLabels[phase];
      const node = replyRegion('input:' + groupId + ':whole', title, true);
      node.className = 'message aide assistant-reply reply-envelope'; node.dataset.inputId = groupId;
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
  let activityId;
  const activityNodes = new Map();
  function progressNode(kind) {
    const node = element(kind === 'text' ? 'div' : 'details', undefined, 'activity-block ' + kind);
    if (kind !== 'text') { node.open = true; node.append(element('summary')); }
    node.append(element('div', '', 'activity-content')); return node;
  }
  function updateProgress(node, kind, text, status, detail) {
    if (kind === 'thought') node.querySelector('summary').textContent = '思考过程';
    if (kind === 'question') node.querySelector('summary').textContent = '问题 · ' + (status === 'answered' ? '已回答' : status === 'cancelled' ? '已取消' : '等待回答');
    if (kind === 'tool') node.querySelector('summary').textContent = text + ' · ' + (toolLabels[status] || status || '状态未知');
    const content = node.querySelector('.activity-content');
    const value = kind === 'tool' ? detail || '' : text;
    if (kind === 'tool') {
      if (content.textContent !== value) content.textContent = value;
    } else {
      content.classList.add('markdown'); updateMarkdown(content, value);
    }
  }
  function renderActivity(activity) {
    const area = $('activity');
    const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 100;
    area.hidden = !activity;
    if (!activity) { area.replaceChildren(); activityNodes.clear(); activityId = undefined; return; }
    if (activity.id !== activityId) {
      activityId = activity.id; activityNodes.clear(); area.replaceChildren();
      const envelope = replyRegion('input:' + activity.id + ':whole', 'Aide · 正在处理', true); envelope.className = 'reply-envelope';
      const heading = envelope.querySelector('summary'); heading.id = 'activity-heading'; heading.className = 'activity-heading'; heading.setAttribute('role', 'status');
      const thought = replyPart('input:' + activity.id + ':think', '过程', activity.phase, 'process'); thought.id = 'activity-thought';
      const reply = replyPart('input:' + activity.id + ':answer', '回答', activity.phase, 'answer');
      const body = element('div', undefined, 'markdown message-body'); body.id = 'activity-answer'; reply.append(body);
      envelope.append(thought, reply); area.append(envelope);
    }
    const last = activity.blocks.at(-1);
    const label = activity.phase === 'waiting' ? '等待你回答' : activity.phase === 'queued' ? '正在排队'
      : last?.kind === 'tool' && last.status === 'in_progress' ? '正在调用工具'
      : last?.kind === 'thought' ? '正在思考' : last?.kind === 'text' ? '正在回复' : '正在处理';
    $('activity-heading').textContent = 'Aide · ' + label + '…' + (activity.queued ? ` · ${activity.queued} 条待处理` : '');
    const lastText = activity.blocks.filter((block) => block.kind === 'text').at(-1);
    const pending = activity.questions.filter((block) => block.status === 'pending');
    const answer = pending.map((block) => block.content).join('\n\n') || activity.answers.join('\n\n') || lastText?.text || '';
    updateAnswer($('activity-answer').parentElement, activity.phase, answer);
    const process = activity.blocks.filter((block) => block.kind !== 'text' ||
      (activity.answers.length ? block.phase !== 'final' && !activity.answers.includes(block.text) : block !== lastText))
      .concat(activity.questions.filter((block) => block.status !== 'pending').map((block) => ({ ...block, kind: block.type, text: block.content })));
    updateProcess($('activity-thought'), activity.phase, process.map((block) => ({ type: block.kind, content: block.text, status: block.status })));
    const ids = new Set(process.map((block) => block.id));
    for (const [id, node] of activityNodes) if (!ids.has(id)) { node.remove(); activityNodes.delete(id); }
    for (const block of process) {
      let node = activityNodes.get(block.id);
      if (!node) { node = progressNode(block.kind); activityNodes.set(block.id, node); $('activity-thought').append(node); }
      updateProgress(node, block.kind, block.text, block.status, block.detail);
    }
    if (nearBottom) $('messages').scrollTop = $('messages').scrollHeight;
  }
  const deletingWork = new Set();
  function renderWork(works) {
    const signature = JSON.stringify(works);
    if (signature === lastWork) return;
    lastWork = signature;
    renderWorkGroup(works.filter((work) => work.kind === 'task'), 'tasks', 'task-count', '还没有事项，交办一件事试试。');
    renderWorkGroup(works.filter((work) => work.kind === 'routine'), 'routines', 'routine-count', '还没有安排，可以告诉我想定期处理或长期关注什么。');
  }
  function renderWorkGroup(works, listId, countId, emptyText) {
    $(countId).textContent = works.length;
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
          await navigator.clipboard.writeText(work.id);
          copy.textContent = '已复制';
        } catch {
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
          await api('/work/delete', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: work.id, conversationId, revision: work.revision }) });
          $('work-notice').textContent = '已删除「' + work.title + '」。';
        } catch (error) {
          $('work-notice').className = 'error'; $('work-notice').textContent = error.message;
        } finally {
          deletingWork.delete(work.id); remove.disabled = false; remove.textContent = '删除';
          await poll();
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
      detail.append(element('summary', '查看目标与进展'), element('p', work.instruction));
      const latest = [...work.history].reverse().find((entry) => entry.role === 'aide');
      if (latest) detail.append(element('p', latest.text));
      node.append(detail); list.append(node);
    }
  }
  function renderInteractions(interactions) {
    const signature = JSON.stringify(interactions);
    if (signature === lastInteractions) return;
    lastInteractions = signature;
    $('interactions').replaceChildren();
    for (const item of interactions) {
      const request = item.request;
      const node = element('article', undefined, 'interaction');
      const actions = element('div', undefined, 'actions');
      const status = element('p', '', 'muted');
      function action(label, result) {
        const button = element('button', label);
        button.type = 'button';
        button.addEventListener('click', async () => {
          actions.querySelectorAll('button').forEach((button) => button.disabled = true);
          try {
            await api('/interactions', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ messageId: item.messageId, result: typeof result === 'function' ? result() : result }) });
            node.remove();
            await poll();
          } catch (error) {
            status.textContent = error.message;
            actions.querySelectorAll('button').forEach((button) => button.disabled = false);
          }
        });
        actions.append(button);
      }
      if (request.kind === 'hook_trust') {
        node.append(element('strong', request.harnessName + ' 等待确认启动 Hooks'),
          element('p', '以下 Hooks 尚未受信任或内容已变更。信任后，它们可以在对应的执行事件中运行。此决定作用于当前 Aide 实例。'));
        const details = element('details');
        details.append(element('summary', '查看 Hooks 的来源与执行命令'));
        for (const hook of request.hooks) details.append(element('pre',
          [hook.key + ' · ' + (hook.trustStatus === 'modified' ? '已变更' : '尚未信任'),
            hook.sourcePath, hook.command, hook.currentHash || ''].join('\n')));
        node.append(details);
        action('信任并继续', { kind: 'hook_trust', outcome: 'trusted' });
        action('不启用这些 Hooks，继续', { kind: 'hook_trust', outcome: 'skipped' });
      } else if (request.kind === 'permission') {
        node.append(element('strong', request.title));
        if (request.description) node.append(element('p', request.description));
        for (const option of request.options) action(option.name, { kind: 'permission', outcome: 'selected', optionId: option.optionId });
      } else if (request.kind === 'question') {
        const fields = [];
        for (const question of request.questions) {
          node.append(element('strong', question.header), element('p', question.question));
          if (request.questions.length === 1) {
            for (const choice of question.choices || []) action(choice.label,
              { kind: 'question', outcome: 'answered', answers: { [question.questionId]: [choice.value] } });
          }
          if (question.allowOther || !question.choices?.length) {
            const field = element('input'); field.placeholder = '输入答复'; node.append(field);
            fields.push({ id: question.questionId, field });
          }
        }
        if (fields.length === request.questions.length) action('提交答复', () => ({ kind: 'question', outcome: 'answered',
          answers: Object.fromEntries(fields.map(({ id, field }) => [id, [field.value]])) }));
      } else {
        node.append(element('strong', '执行正在等待用户回应'),
          element('p', '网页暂不支持此类回应，可以取消本次执行。'), element('pre', JSON.stringify(request, null, 2)));
      }
      action('取消执行', { kind: 'cancelled', reason: 'user' });
      node.append(actions, status);
      $('interactions').append(node);
    }
  }
  /** @spec 轮询故障和恢复仅更新轮询状态，不覆盖发送结果或实时连接状态。 */
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const [works, interactions] = await Promise.all([api('/work' + query), api('/interactions' + query), refreshConversations()]);
      renderWork(works); renderInteractions(interactions);
      $('poll-notice').textContent = '';
    } catch { $('poll-notice').textContent = '事项或交互暂时无法更新，正在重试。'; }
    finally { polling = false; }
  }
  $('composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('input').value.trim();
    if (!text || sending) return;
    sending = true; $('send').disabled = true; $('input').disabled = true;
    $('notice').className = ''; $('notice').textContent = '正在理解你的请求…';
    try {
      if (!draft || draft.text !== text) {
        const conversations = await api('/conversations');
        const sessionId = conversations.find((item) => item.id === conversationId)?.sessionId || conversationId;
        draft = { id: crypto.randomUUID(), sessionId, text };
      }
      await api('/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
      draft = null; $('input').value = ''; $('notice').textContent = '已接收，后续进展会显示在这里。';
      await poll(); $('messages').scrollTop = $('messages').scrollHeight;
    } catch (error) { $('notice').className = 'error'; $('notice').textContent = error.message + ' 原消息编号会保留，避免重复交办。'; }
    finally { sending = false; $('send').disabled = false; $('input').disabled = false; $('input').focus(); }
  });
  $('input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
  });
  const stream = new EventSource('/stream' + query);
  let view = {};
  stream.onmessage = (event) => {
    try {
      const patch = parsePatchEvent(event.data);
      view = applyPatch(view, patch);
      if (patch.op === 'ping' || patch.op === 'end') return;
      renderMessages(view.blocks, view.meta.activity);
      const liveIds = new Set(view.blocks.filter((block) => block.type === 'execution' &&
        (block.status === 'running' || (view.meta.activity && block.group_id === view.meta.activity.id))).map((block) => block.id));
      renderActivity(view.meta.activity && { ...view.meta.activity,
        answers: view.blocks.filter((block) => block.type === 'message' && block.role === 'aide' && block.group_id === view.meta.activity.id).map((block) => block.content),
        questions: view.blocks.filter((block) => block.type === 'question' && block.group_id === view.meta.activity.id),
        blocks: view.blocks.filter((block) => liveIds.has(block.parent_id))
          .map((block) => ({ ...block, kind: block.type, text: block.content })) });
      $('connection').textContent = view.meta.error ? view.meta.error.message : '实时连接';
    } catch {
      stream.close(); $('connection').textContent = '无法读取对话进展，请刷新页面重试';
    }
  };
  stream.onopen = () => { $('connection').textContent = '实时连接'; };
  stream.onerror = () => { $('connection').textContent = '连接断开 · 正在重连'; };
  renderConversations([]);
  poll(); setInterval(poll, 1500);
