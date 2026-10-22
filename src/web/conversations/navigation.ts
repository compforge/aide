import { byId as $, element, newId } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import { copyText } from '../shared/clipboard.ts';
import { conversationPage } from './pagination.ts';
import type { ConversationItem } from '../../api/types.ts';
type NavigationItem = ConversationItem | { id: string; name: string; preview: string; default?: false; trigger?: undefined; taskCount?: 0; routineCount?: 0 };

/**
 * @spec Conversation selection keeps the current document and sidebar; Back/Forward restores the selected scope.
 * @spec Navigation owns page intent and menus; refresh never converts automatic following into a fixed page.
 */
export function createNavigation(conversationId: string | null, signal: AbortSignal, onSelect: (id: string | null) => void) {
  function conversationCopyButton(id: string, compact = false) {
    const button = element('button', compact ? '⧉' : '复制 ID', 'conversation-copy');
    button.type = 'button'; button.title = '复制会话 ID';
    button.setAttribute('aria-label', '复制会话 ID');
    button.addEventListener('click', async () => {
      try {
        await copyText(id); button.textContent = '已复制';
        $('conversation-notice').textContent = '';
      } catch { $('conversation-notice').textContent = '复制会话 ID 失败，请重试。'; return; }
      setTimeout(() => { button.textContent = compact ? '⧉' : '复制 ID'; }, 1500);
    });
    return button;
  }

  let lastConversations = '', conversationUpdating = false;
  let conversationItems: ConversationItem[] = [];
  const initialPage = Number(new URL(location.href).searchParams.get('page'));
  let requestedPage = Number.isSafeInteger(initialPage) && initialPage > 0 ? initialPage : null;
  let currentPage = 1;
  function navigate(url: URL, replace = false) {
    const next = url.searchParams.get('conversation');
    const changed = next !== conversationId;
    conversationMenu.hidePopover();
    conversationId = next;
    const page = Number(url.searchParams.get('page'));
    requestedPage = Number.isSafeInteger(page) && page > 0 ? page : null;
    history[replace ? 'replaceState' : 'pushState'](null, '', url.href);
    renderConversations(conversationItems);
    if (changed) onSelect(conversationId);
  }
  window.addEventListener('popstate', () => {
    const next = new URL(location.href);
    navigate(next, true);
  }, { signal });
  for (const [id, offset] of [['conversation-previous', -1], ['conversation-next', 1]] as const) {
    $(id).addEventListener('click', () => {
      conversationMenu.hidePopover();
      requestedPage = currentPage + offset;
      renderConversations(conversationItems);
      $('conversation-list').parentElement!.scrollTop = 0;
    });
  }
  let menuButton: HTMLButtonElement | null = null;
  const conversationMenu = element('div', undefined, 'conversation-menu');
  conversationMenu.id = 'conversation-menu'; conversationMenu.popover = 'auto';
  conversationMenu.setAttribute('role', 'menu'); conversationMenu.setAttribute('aria-label', '会话操作');
  document.body.append(conversationMenu);
  conversationMenu.addEventListener('toggle', (event) => {
    if (event.newState === 'closed') menuButton?.setAttribute('aria-expanded', 'false');
  });
  conversationMenu.addEventListener('keydown', (event) => {
    const buttons = [...conversationMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (event.key === 'Escape') {
      conversationMenu.hidePopover(); menuButton?.focus(); return;
    }
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length
      : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
    if (next !== null) { event.preventDefault(); buttons[next]?.focus(); }
  });
  // A top-layer popover avoids clipping at the bottom of the scrollable sidebar.
  $('conversation-list').parentElement!.addEventListener('scroll', () => conversationMenu.hidePopover());
  window.addEventListener('resize', () => conversationMenu.hidePopover(), { signal });
  async function changeConversation(item: ConversationItem, action: string) {
    conversationMenu.hidePopover();
    if (conversationUpdating) return;
    if (action === 'delete' && !confirm('删除会话「' + item.name + '」及其聊天记录？\n有待处理内容或关联事项、安排时，需要先处理。')) return;
    conversationUpdating = true;
    document.querySelectorAll<HTMLButtonElement>('.conversation-more').forEach((button) => { button.disabled = true; });
    try {
      const payload = action === 'delete' ? { conversationId: item.id, revision: item.revision, uid: item.uid }
        : { conversationId: item.id, enabled: action === 'default' ? !item.default : !item.trigger.enabled };
      await request('/conversations/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const remaining = await request<ConversationItem[]>('/conversations');
      if (action === 'delete' && item.id === conversationId) {
        const url = new URL(location.href);
        const next = remaining.find((candidate) => candidate.default) || remaining[0];
        if (next) url.searchParams.set('conversation', next.id); else url.searchParams.delete('conversation');
        conversationItems = remaining; navigate(url, true); return;
      }
      lastConversations = ''; renderConversations(remaining);
      $('conversation-notice').textContent = action === 'delete' ? '已删除「' + item.name + '」。' : '';
    } catch (error) {
      $('conversation-notice').textContent = '会话操作失败：' + errorMessage(error);
      lastConversations = '';
    } finally {
      conversationUpdating = false;
      document.querySelectorAll<HTMLButtonElement>('.conversation-more').forEach((button) => { button.disabled = false; });
      document.querySelector<HTMLButtonElement>('.conversation-more[data-conversation-id="' + CSS.escape(item.id) + '"]')?.focus();
    }
  }
  function conversationMenuButton(item: ConversationItem) {
    const button = element('button', '⋯', 'conversation-more');
    button.type = 'button'; button.title = '会话操作'; button.dataset.conversationId = item.id;
    button.setAttribute('aria-label', '会话操作：' + item.name);
    button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-controls', conversationMenu.id);
    button.setAttribute('aria-expanded', 'false'); button.disabled = conversationUpdating;
    button.addEventListener('click', () => {
      const wasOpen = conversationMenu.matches(':popover-open');
      conversationMenu.hidePopover();
      menuButton?.setAttribute('aria-expanded', 'false');
      if (wasOpen && menuButton === button) return;
      menuButton = button;
      conversationMenu.replaceChildren();
      for (const [action, label] of [['default', item.default ? '取消默认' : '设置默认'],
        ['trigger', item.trigger.enabled ? '取消回顾' : '开启回顾'], ['delete', '删除会话']] as const) {
        const option = element('button', label, action === 'delete' ? 'conversation-delete' : '');
        option.type = 'button'; option.setAttribute('role', 'menuitem');
        option.addEventListener('click', () => changeConversation(item, action));
        conversationMenu.append(option);
      }
      conversationMenu.showPopover(); button.setAttribute('aria-expanded', 'true');
      const rect = button.getBoundingClientRect();
      conversationMenu.style.left = Math.max(8, Math.min(rect.right - conversationMenu.offsetWidth, innerWidth - conversationMenu.offsetWidth - 8)) + 'px';
      conversationMenu.style.top = Math.max(8, Math.min(rect.bottom + 4, innerHeight - conversationMenu.offsetHeight - 8)) + 'px';
      conversationMenu.querySelector('button')?.focus();
    });
    return button;
  }
  function conversationStatusIcon(label: string, drawing: string) {
    const icon = element('span', undefined, 'conversation-status-icon');
    icon.title = label; icon.setAttribute('aria-label', label); icon.setAttribute('role', 'img');
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + drawing + '</svg>';
    return icon;
  }
  function renderConversations(conversations: ConversationItem[]) {
    conversationItems = conversations;
    const items: NavigationItem[] = [...conversations];
    if (conversationId && !items.some((item) => item.id === conversationId)) items.push({ id: conversationId, name: '新对话', preview: '' });
    const current = items.find((item) => item.id === conversationId);
    $('conversation-heading').textContent = current?.name || '选择一个会话';
    const copy = $('conversation-copy');
    if (copy.dataset.conversationId !== (conversationId ?? '')) {
      copy.dataset.conversationId = conversationId ?? '';
      copy.replaceChildren(...(conversationId ? [conversationCopyButton(conversationId)] : []));
    }
    for (const link of $('conversation-list').querySelectorAll<HTMLAnchorElement>('.list-link')) {
      if (link.dataset.conversationId === conversationId) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const paged = conversationPage(items, requestedPage, conversationId);
    currentPage = paged.page;
    requestedPage = paged.requestedPage;
    const pageUrl = new URL(location.href);
    if (requestedPage === null) pageUrl.searchParams.delete('page');
    else pageUrl.searchParams.set('page', String(requestedPage));
    history.replaceState(null, '', pageUrl.href);
    $('conversation-pagination').hidden = paged.pages === 1;
    $('conversation-page').textContent = currentPage + ' / ' + paged.pages;
    $<HTMLButtonElement>('conversation-previous').disabled = currentPage === 1;
    $<HTMLButtonElement>('conversation-next').disabled = currentPage === paged.pages;
    const signature = JSON.stringify({ page: paged.page, items: paged.items });
    if (signature === lastConversations) return;
    lastConversations = signature;
    const links = paged.items.map((item) => {
      const link = element('a', undefined, 'list-link');
      const url = new URL(location.href); url.searchParams.set('conversation', item.id);
      url.searchParams.set('page', String(currentPage));
      link.href = url.href;
      link.dataset.conversationId = item.id;
      link.addEventListener('click', (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
        event.preventDefault();
        if (item.id !== conversationId) navigate(new URL(link.href));
      });
      if (item.id === conversationId) link.setAttribute('aria-current', 'page');
      link.title = item.name;
      link.append(element('strong', item.name));
      if (item.preview) link.append(element('span', item.preview, 'muted'));
      link.append(element('span', '事项 ' + (item.taskCount ?? 0) + ' · 安排 ' + (item.routineCount ?? 0), 'muted conversation-counts'));
      const indicators = element('span', undefined, 'conversation-indicators');
      if (item.default) indicators.append(conversationStatusIcon('默认联络处', '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>'));
      if (item.trigger?.enabled) indicators.append(conversationStatusIcon('主动回顾已开启', '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M3 5l3-3m12 0 3 3M6 20l-2 2m14-2 2 2"/>'));
      if (indicators.childElementCount) link.append(indicators);
      const row = element('div', undefined, 'conversation-row');
      const entry = element('div', undefined, 'conversation-entry');
      const actions = element('div', undefined, 'conversation-actions');
      actions.append(conversationCopyButton(item.id, true));
      if ('revision' in item) actions.append(conversationMenuButton(item));
      entry.append(link, actions); row.append(entry);
      return row;
    });
    $('conversation-list').replaceChildren(...links);
  }
  async function refreshConversations() {
    try {
      if (conversationUpdating || conversationMenu.matches(':popover-open')) return;
      renderConversations(await request<ConversationItem[]>('/conversations'));
      if ($('conversation-notice').textContent === '会话列表暂时无法更新，正在重试。') $('conversation-notice').textContent = '';
    } catch { $('conversation-notice').textContent = '会话列表暂时无法更新，正在重试。'; }
  }
  $('new-conversation').addEventListener('click', () => { navigate(new URL('/?conversation=' + encodeURIComponent('web:' + newId()), location.href)); });
  signal.addEventListener('abort', () => conversationMenu.remove(), { once: true });
  return { refresh: refreshConversations };
}
