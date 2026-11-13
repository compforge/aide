import type { TopicChild, TopicChildrenView } from '../../api/types.ts';
import { byId, element } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';

/**
 * @spec Initially show only the selected Topic's direct children; expanding a child loads its own paged children.
 * @spec Topic names are native detail links; the disclosure control independently expands children.
 * @spec Refresh and topic disposal cancel old requests before they can update the tree.
 * @see {@link component://docs/channel/web.md}
 */
export function createTopicTree(topicId: string | null, lifetime: AbortSignal) {
  const tree = byId('topic-tree'), notice = byId('topic-tree-notice'), pages = byId('topic-tree-pages');
  let active: AbortController | undefined, loaded = false;
  tree.replaceChildren(); notice.textContent = ''; pages.replaceChildren();
  lifetime.addEventListener('abort', () => active?.abort(), { once: true });
  byId('topic-tree-refresh').addEventListener('click', refresh, { signal: lifetime });

  function refresh() {
    if (!topicId || lifetime.aborted) return;
    active?.abort(); active = new AbortController();
    const signal = active.signal;
    loaded = true; tree.replaceChildren(); pages.replaceChildren();

    function branch(parentId: string, children: HTMLElement, status: HTMLElement, controls: HTMLElement, seen: Set<string>) {
      let fetched = false, busy = false;
      async function load(page = 1) {
        if (busy || signal.aborted) return;
        busy = true; status.textContent = '正在加载…';
        for (const button of controls.querySelectorAll('button')) button.disabled = true;
        try {
          const result = await request<TopicChildrenView>(`/topics/${encodeURIComponent(parentId)}/children?` + new URLSearchParams({ page: String(page), pageSize: '20' }), { signal });
          if (signal.aborted) return;
          children.replaceChildren(...result.items.map(item => node(item, seen)));
          controls.replaceChildren();
          if (result.pages > 1) {
            for (const [label, delta] of [['上一页', -1], ['下一页', 1]] as const) {
              const button = element('button', label); button.type = 'button';
              button.disabled = delta < 0 ? result.page <= 1 : result.page >= result.pages;
              button.onclick = () => void load(result.page + delta); controls.append(button);
            }
            controls.append(element('span', `${result.page} / ${result.pages}`, 'muted'));
          }
          fetched = true; status.textContent = children.childElementCount ? '' : '暂无子主题。';
        } catch (error) {
          if (!signal.aborted) {
            status.textContent = errorMessage(error); controls.replaceChildren();
            const retry = element('button', '重试'); retry.type = 'button';
            retry.onclick = () => void load(page); controls.append(retry);
          }
        } finally { busy = false; }
      }
      return { show() { if (!fetched) void load(); } };
    }

    function node(item: TopicChild, seen: Set<string>): HTMLLIElement {
      const li = element('li'), link = element('a', item.name, 'tree-name');
      link.href = '/?' + new URLSearchParams({ topic: item.id });
      if (!item.hasChildren || seen.has(item.uid)) { li.append(link); return li; }
      const details = element('details'), summary = element('summary');
      summary.append(link);
      const children = element('ul'), status = element('p', '', 'muted'), controls = element('div', undefined, 'tree-pages');
      const nested = branch(item.id, children, status, controls, new Set([...seen, item.uid]));
      details.append(summary, children, status, controls); li.append(details);
      details.addEventListener('toggle', () => { if (details.open) nested.show(); });
      return li;
    }

    branch(topicId, tree, notice, pages, new Set()).show();
  }
  return { show() { if (!loaded) refresh(); } };
}
