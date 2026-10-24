import { byId as $, element, newId } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import { copyText } from '../shared/clipboard.ts';
import { topicPage, topicTree } from './pagination.ts';
import type { TopicItem } from '../../api/types.ts';
type NavigationItem = TopicItem | { id: string; name: string; preview: string; default?: false; trigger?: undefined; taskCount?: 0; routineCount?: 0 };

/**
 * @spec Topic selection keeps the current document and sidebar; Back/Forward restores the selected scope.
 * @spec Navigation owns page intent and menus; refresh never converts automatic following into a fixed page.
 */
export function createNavigation(topicId: string | null, signal: AbortSignal, onSelect: (id: string | null) => void) {
  function topicCopyButton(id: string, compact = false) {
    const button = element('button', compact ? '⧉' : '复制 ID', 'topic-copy');
    button.type = 'button'; button.title = '复制主题 ID';
    button.setAttribute('aria-label', '复制主题 ID');
    button.addEventListener('click', async () => {
      try {
        await copyText(id); button.textContent = '已复制';
        $('topic-notice').textContent = '';
      } catch { $('topic-notice').textContent = '复制主题 ID 失败，请重试。'; return; }
      setTimeout(() => { button.textContent = compact ? '⧉' : '复制 ID'; }, 1500);
    });
    return button;
  }

  const expanded = new Set<string>();
  let lastTopics = '', topicUpdating = false;
  let topicItems: TopicItem[] = [];
  const initialPage = Number(new URL(location.href).searchParams.get('page'));
  let requestedPage = Number.isSafeInteger(initialPage) && initialPage > 0 ? initialPage : null;
  let currentPage = 1;
  function navigate(url: URL, replace = false) {
    const next = url.searchParams.get('topic');
    const changed = next !== topicId;
    topicMenu.hidePopover();
    topicId = next;
    const page = Number(url.searchParams.get('page'));
    requestedPage = Number.isSafeInteger(page) && page > 0 ? page : null;
    history[replace ? 'replaceState' : 'pushState'](null, '', url.href);
    renderTopics(topicItems);
    if (changed) onSelect(topicId);
  }
  window.addEventListener('popstate', () => {
    const next = new URL(location.href);
    navigate(next, true);
  }, { signal });
  for (const [id, offset] of [['topic-previous', -1], ['topic-next', 1]] as const) {
    $(id).addEventListener('click', () => {
      topicMenu.hidePopover();
      requestedPage = currentPage + offset;
      renderTopics(topicItems);
      $('topic-list').parentElement!.scrollTop = 0;
    });
  }
  let menuButton: HTMLButtonElement | null = null;
  const topicMenu = element('div', undefined, 'topic-menu');
  topicMenu.id = 'topic-menu'; topicMenu.popover = 'auto';
  topicMenu.setAttribute('role', 'menu'); topicMenu.setAttribute('aria-label', '主题操作');
  document.body.append(topicMenu);
  topicMenu.addEventListener('toggle', (event) => {
    if (event.newState === 'closed') menuButton?.setAttribute('aria-expanded', 'false');
  });
  topicMenu.addEventListener('keydown', (event) => {
    const buttons = [...topicMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (event.key === 'Escape') {
      topicMenu.hidePopover(); menuButton?.focus(); return;
    }
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length
      : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
    if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
  });
  // A top-layer popover avoids clipping at the bottom of the scrollable sidebar.
  $('topic-list').parentElement!.addEventListener('scroll', () => topicMenu.hidePopover());
  window.addEventListener('resize', () => topicMenu.hidePopover(), { signal });
  async function changeTopic(item: TopicItem, action: string) {
    topicMenu.hidePopover();
    if (topicUpdating) return;
    if (action === 'delete' && !confirm('删除主题「' + item.name + '」及其聊天记录？\n有待处理内容或关联事项、安排时，需要先处理。')) return;
    topicUpdating = true;
    document.querySelectorAll<HTMLButtonElement>('.topic-more').forEach((button) => { button.disabled = true; });
    try {
      const payload = action === 'delete' ? { topicId: item.id, revision: item.revision, uid: item.uid }
        : { topicId: item.id, enabled: action === 'default' ? !item.default : !item.trigger.enabled };
      await request('/topics/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const remaining = await request<TopicItem[]>('/topics');
      if (action === 'delete' && item.id === topicId) {
        const url = new URL(location.href);
        const next = remaining.find((candidate) => candidate.default) || remaining[0];
        if (next) url.searchParams.set('topic', next.id); else url.searchParams.delete('topic');
        topicItems = remaining; navigate(url, true); return;
      }
      lastTopics = ''; renderTopics(remaining);
      $('topic-notice').textContent = action === 'delete' ? '已删除「' + item.name + '」。' : '';
    } catch (error) {
      $('topic-notice').textContent = '主题操作失败：' + errorMessage(error);
      lastTopics = '';
    } finally {
      topicUpdating = false;
      document.querySelectorAll<HTMLButtonElement>('.topic-more').forEach((button) => { button.disabled = false; });
      document.querySelector<HTMLButtonElement>('.topic-more[data-topic-id="' + CSS.escape(item.id) + '"]')?.focus();
    }
  }
  function topicMenuButton(item: TopicItem) {
    const button = element('button', '⋯', 'topic-more');
    button.type = 'button'; button.title = '主题操作'; button.dataset.topicId = item.id;
    button.setAttribute('aria-label', '主题操作：' + item.name);
    button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-controls', topicMenu.id);
    button.setAttribute('aria-expanded', 'false'); button.disabled = topicUpdating;
    button.addEventListener('click', () => {
      const wasOpen = topicMenu.matches(':popover-open');
      topicMenu.hidePopover();
      menuButton?.setAttribute('aria-expanded', 'false');
      if (wasOpen && menuButton === button) return;
      menuButton = button;
      topicMenu.replaceChildren();
      const actions = [['trigger', item.trigger.enabled ? '取消回顾' : '开启回顾']];
      if (!item.default) actions.push(['delete', '删除主题']);
      if (!topicItems.some(t => t.default) && !item.parentUid) actions.push(['default', '设为默认主题']);
      for (const [action, label] of actions as [string, string][]) {
        const option = element('button', label, action === 'delete' ? 'topic-delete' : '');
        option.type = 'button'; option.setAttribute('role', 'menuitem');
        option.addEventListener('click', () => changeTopic(item, action));
        topicMenu.append(option);
      }
      topicMenu.showPopover(); button.setAttribute('aria-expanded', 'true');
      const rect = button.getBoundingClientRect();
      topicMenu.style.left = Math.max(8, Math.min(rect.right - topicMenu.offsetWidth, innerWidth - topicMenu.offsetWidth - 8)) + 'px';
      topicMenu.style.top = Math.max(8, Math.min(rect.bottom + 4, innerHeight - topicMenu.offsetHeight - 8)) + 'px';
      topicMenu.querySelector('button')?.focus();
    });
    return button;
  }
  function topicStatusIcon(label: string, drawing: string) {
    const icon = element('span', undefined, 'topic-status-icon');
    icon.title = label; icon.setAttribute('aria-label', label); icon.setAttribute('role', 'img');
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + drawing + '</svg>';
    return icon;
  }
  function renderTopics(topics: TopicItem[]) {
    topicItems = topics;
    const ancestry = new Map(topics.map(t => [t.uid, t]));
    let parent = topics.find(t => t.id === topicId)?.parentUid;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) { visited.add(parent); expanded.add(parent); parent = ancestry.get(parent)?.parentUid; }
    const tree = topicTree(topics, expanded);
    const depths = new Map(tree.map(t => [t.item.id, t.depth]));
    const items: NavigationItem[] = tree.map(t => t.item);
    if (topicId && !items.some((item) => item.id === topicId)) items.push({ id: topicId, name: '新对话', preview: '' });
    const current = items.find((item) => item.id === topicId);
    $('topic-heading').textContent = current?.name || '选择一个主题';
    const copy = $('topic-copy');
    if (copy.dataset.topicId !== (topicId ?? '')) {
      copy.dataset.topicId = topicId ?? '';
      copy.replaceChildren(...(topicId ? [topicCopyButton(topicId)] : []));
    }
    for (const link of $('topic-list').querySelectorAll<HTMLAnchorElement>('.list-link')) {
      if (link.dataset.topicId === topicId) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const paged = topicPage(items, requestedPage, topicId);
    currentPage = paged.page;
    requestedPage = paged.requestedPage;
    const pageUrl = new URL(location.href);
    if (requestedPage === null) pageUrl.searchParams.delete('page');
    else pageUrl.searchParams.set('page', String(requestedPage));
    history.replaceState(null, '', pageUrl.href);
    $('topic-pagination').hidden = paged.pages === 1;
    $('topic-page').textContent = currentPage + ' / ' + paged.pages;
    $<HTMLButtonElement>('topic-previous').disabled = currentPage === 1;
    $<HTMLButtonElement>('topic-next').disabled = currentPage === paged.pages;
    const signature = JSON.stringify({ page: paged.page, items: paged.items });
    if (signature === lastTopics) return;
    lastTopics = signature;
    const links = paged.items.map((item) => {
      const link = element('a', undefined, 'list-link');
      const url = new URL(location.href); url.searchParams.set('topic', item.id);
      url.searchParams.set('page', String(currentPage));
      link.href = url.href;
      link.dataset.topicId = item.id;
      link.addEventListener('click', (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
        event.preventDefault();
        if (item.id !== topicId) navigate(new URL(link.href));
      });
      if (item.id === topicId) link.setAttribute('aria-current', 'page');
      link.title = item.name;
      link.append(element('strong', item.name));
      if (item.preview) link.append(element('span', item.preview, 'muted'));
      link.append(element('span', '事项 ' + (item.taskCount ?? 0) + ' · 安排 ' + (item.routineCount ?? 0), 'muted topic-counts'));
      const indicators = element('span', undefined, 'topic-indicators');
      if (item.default) indicators.append(topicStatusIcon('默认联络处', '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>'));
      if (item.trigger?.enabled) indicators.append(topicStatusIcon('主动回顾已开启', '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M3 5l3-3m12 0 3 3M6 20l-2 2m14-2 2 2"/>'));
      if (indicators.childElementCount) link.append(indicators);
      const row = element('div', undefined, 'topic-row');
      const entry = element('div', undefined, 'topic-entry');
      const actions = element('div', undefined, 'topic-actions');
      actions.append(topicCopyButton(item.id, true));
      if ('revision' in item) actions.append(topicMenuButton(item));
      const children = 'uid' in item && topics.some(t => t.parentUid === item.uid);
      if (children && 'uid' in item && item.uid) {
        const toggle = element('button', expanded.has(item.uid) ? '▾' : '▸', 'topic-expand');
        toggle.type = 'button'; toggle.setAttribute('aria-label', '展开或收起子主题');
        toggle.setAttribute('aria-expanded', String(expanded.has(item.uid)));
        toggle.addEventListener('click', () => { expanded.has(item.uid!) ? expanded.delete(item.uid!) : expanded.add(item.uid!); lastTopics = ''; renderTopics(topicItems); });
        entry.append(toggle);
      }
      row.style.paddingInlineStart = `${(depths.get(item.id) ?? 0) * 14}px`;
      entry.append(link, actions); row.append(entry);
      return row;
    });
    $('topic-list').replaceChildren(...links);
  }
  async function refreshTopics() {
    try {
      if (topicUpdating || topicMenu.matches(':popover-open')) return;
      renderTopics(await request<TopicItem[]>('/topics'));
      if ($('topic-notice').textContent === '主题列表暂时无法更新，正在重试。') $('topic-notice').textContent = '';
    } catch { $('topic-notice').textContent = '主题列表暂时无法更新，正在重试。'; }
  }
  $('new-topic').addEventListener('click', () => { navigate(new URL('/?topic=' + encodeURIComponent('web:' + newId()), location.href)); });
  signal.addEventListener('abort', () => topicMenu.remove(), { once: true });
  return { refresh: refreshTopics };
}
