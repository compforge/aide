import type { TopicItem, TopicListView } from '../../api/types.ts';
import { byId, element } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';

/**
 * @spec Show the selected topic's root tree using paged direct children; expand its ancestor path without scanning other branches.
 * @spec Topic names are native detail links; the disclosure control independently expands children.
 * @spec Refresh and topic disposal cancel old requests before they can update the tree.
 * @see {@link component://docs/channel/web.md}
 */
export function createTopicTree(topicId: string | null, lifetime: AbortSignal) {
  const tree = byId('topic-tree'), notice = byId('topic-tree-notice');
  let active: AbortController | undefined, loaded = false;
  tree.replaceChildren(); notice.textContent = '';
  lifetime.addEventListener('abort', () => active?.abort(), { once: true });
  byId('topic-tree-refresh').addEventListener('click', () => void refresh(), { signal: lifetime });

  async function refresh() {
    if (!topicId || lifetime.aborted) return;
    active?.abort(); active = new AbortController();
    const signal = active.signal;
    loaded = true; tree.replaceChildren(); notice.textContent = '正在加载…';
    const read = (params: Record<string, string>) => request<TopicListView>('/topics?' + new URLSearchParams(params), { signal });
    try {
      const result = await read({ selectedId: topicId, pageSize: '1' });
      if (signal.aborted) return;
      const path = result.path, root = path[0], selected = path.at(-1);
      if (!root || selected?.id !== topicId) { notice.textContent = '主题尚未创建或已删除。'; return; }
      const ancestors = new Set(path.map(item => item.uid));
      notice.textContent = '';
      function node(item: TopicItem, seen: Set<string>): HTMLLIElement {
        const li = element('li');
        if (item.uid === selected!.uid) li.classList.add('tree-current');
        const link = element('a', item.name, 'tree-name');
        link.href = '/?' + new URLSearchParams({ topic: item.id });
        if (item.uid === selected!.uid) link.setAttribute('aria-current', 'page');
        if (!item.childCount || seen.has(item.uid)) {
          li.append(link); return li;
        }
        const details = element('details'), summary = element('summary');
        summary.append(link);
        const children = element('ul'), status = element('p', '', 'muted'), controls = element('div', undefined, 'tree-pages');
        const branch = new Set([...seen, item.uid]);
        let fetched = false, busy = false;
        async function load(page?: number) {
          if (busy || signal.aborted) return;
          busy = true; status.textContent = '正在加载…';
          for (const button of controls.querySelectorAll('button')) button.disabled = true;
          try {
            const result = await read({ parentId: item.id, selectedId: topicId!, pageSize: '20', ...(page ? { page: String(page) } : {}) });
            if (signal.aborted) return;
            children.replaceChildren(...[...result.pinned, ...result.items].map(child => node(child, branch)));
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
              status.textContent = errorMessage(error);
              controls.replaceChildren();
              const retry = element('button', '重试'); retry.type = 'button';
              retry.onclick = () => void load(page); controls.append(retry);
            }
          } finally { busy = false; }
        }
        details.append(summary, children, status, controls); li.append(details);
        details.addEventListener('toggle', () => { if (details.open && !fetched) void load(); });
        details.open = ancestors.has(item.uid);
        return li;
      }
      tree.replaceChildren(node(root, new Set()));
    } catch (error) { if (!signal.aborted) { loaded = false; notice.textContent = errorMessage(error); } }
  }
  return { show() { if (!loaded) void refresh(); } };
}
