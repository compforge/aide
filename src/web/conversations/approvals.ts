import { byId as $, element } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import type { Approval } from '../../api/types.ts';
import type { ApprovalResult } from '../../host/approval/types.ts';

export function createApprovals(onChange: () => Promise<void>) {
  let lastApprovals = '';
  function renderApprovals(approvals: Approval[]) {
    const signature = JSON.stringify(approvals);
    if (signature === lastApprovals) return;
    lastApprovals = signature;
    $("approvals").replaceChildren();
    for (const item of approvals) {
      const approval = item.request;
      const node = element('article', undefined, "approval");
      const actions = element('div', undefined, 'actions');
      const status = element('p', '', 'muted');
      function action(label: string, result: ApprovalResult) {
        const button = element('button', label);
        button.type = 'button';
        button.addEventListener('click', async () => {
          actions.querySelectorAll('button').forEach((button) => button.disabled = true);
          try {
            await request("/approvals", { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ messageId: item.messageId, result: result }) });
            node.remove();
            await onChange();
          } catch (error) {
            status.textContent = errorMessage(error);
            actions.querySelectorAll('button').forEach((button) => button.disabled = false);
          }
        });
        actions.append(button);
      }
      if (approval.kind === 'hook_trust') {
        node.append(element('strong', approval.harnessName + ' 等待确认启动 Hooks'),
          element('p', '以下 Hooks 尚未受信任或内容已变更。信任后，它们可以在对应的执行事件中运行。此决定作用于当前 Aide 实例。'));
        const details = element('details');
        details.append(element('summary', '查看 Hooks 的来源与执行命令'));
        for (const hook of approval.hooks) details.append(element('pre',
          [hook.key + ' · ' + (hook.trustStatus === 'modified' ? '已变更' : '尚未信任'),
            hook.sourcePath, hook.command, hook.currentHash || ''].join('\n')));
        node.append(details);
        action('信任并继续', { kind: 'hook_trust', outcome: 'trusted' });
        action('不启用这些 Hooks，继续', { kind: 'hook_trust', outcome: 'skipped' });
      } else if (approval.kind === 'permission') {
        node.append(element('strong', approval.title));
        if (approval.description) node.append(element('p', approval.description));
        for (const option of approval.options) action(option.name, { kind: 'permission', outcome: 'selected', optionId: option.optionId });
      } else {
        node.append(element('strong', '执行正在等待用户回应'),
          element('p', '网页暂不支持此类回应，可以取消本次执行。'), element('pre', JSON.stringify(approval, null, 2)));
      }
      action('取消执行', { kind: 'cancelled', reason: 'user' });
      node.append(actions, status);
      $("approvals").append(node);
    }
  }
  return { render: renderApprovals };
}
