import './style.css';
import { byId as $, element as node } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import type { InputListView, InputDetailView, InputFiltersView } from '../../api/types.ts';

let page: InputListView | undefined, selected: { id: string; uid?: string } | undefined;
let generation = 0, timer: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined;
let lastDetail = '', lastList = '';
let filtersRequest: AbortController | undefined;
const query = new URLSearchParams();
const selects = { connector: 'input-connector', sourceUid: 'input-source', state: 'input-state' } as const;
const time = (at?: string) => at ? Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString() : at : '时间未记录';
const statusLabels: Record<string, string> = { completed: '已确认完成', cancelled: '已取消', rejected: '已拒绝', assigned: '已分派', bound: '已绑定', applied: '已应用',
  started: '已开始', attention: '待核对', recorded: '保留的异常记录', pending: '尚未完成', retrying: '等待重试', delivered: '已送达', sending: '投递中', failed: '投递失败', uncertain: '投递待核对' };

function loadLocation() {
  const params = new URL(location.href).searchParams;
  for (const key of [...query.keys()]) query.delete(key);
  for (const key of ['page', 'pageSize', 'q', 'origin', 'originId', 'connector', 'sourceUid', 'state', 'errors']) if (params.has(key)) query.set(key, params.get(key)!);
  selected = params.get('input') ? { id: params.get('input')!, uid: params.get('uid') ?? undefined } : undefined;
  $<HTMLInputElement>('input-search').value = query.get('q') ?? '';
  $<HTMLInputElement>('input-errors').checked = query.get('errors') === 'true';
  for (const [key, id] of Object.entries(selects)) selectValue(id, query.get(key) ?? '*');
  selectValue('input-origin', query.has('originId') ? `${query.get('origin') ?? 'source'}:${query.get('originId')}` : '*');
}
function selectValue(id: string, value: string) {
  const select = $<HTMLSelectElement>(id);
  if (![...select.options].some(o => o.value === value)) select.add(new Option(value || '无 Connector / 未记录', value));
  select.value = value;
}
function saveLocation(push = false) {
  const params = new URLSearchParams(query);
  if (selected) { params.set('input', selected.id); if (selected.uid) params.set('uid', selected.uid); }
  history[push ? 'pushState' : 'replaceState'](null, '', '/inputs' + (params.size ? '?' + params : ''));
}
function options(id: string, allLabel: string, items: { value: string; label: string }[]) {
  const select = $<HTMLSelectElement>(id), value = select.value;
  select.replaceChildren(new Option(allLabel, '*'), ...items.map(item => new Option(item.label, item.value)));
  selectValue(id, value);
}
function renderList(result: InputListView) {
  const signature = JSON.stringify({ result, query: query.toString(), selected });
  if (signature === lastList) return;
  lastList = signature;
  $('input-list').replaceChildren();
  for (const input of result.items) {
    const link = node('a', undefined, 'list-link');
    const params = new URLSearchParams(query); params.set('input', input.id); params.set('uid', input.uid);
    link.href = '/inputs?' + params;
    if (selected?.id === input.id) link.setAttribute('aria-current', 'page');
    link.append(node('strong', input.preview), node('span', `${input.label} · ${input.connector || '无 Connector / 未记录'}`, 'muted'),
      node('span', `${input.state === 'completed' ? '处理完成' : '尚未完成'}${input.errors ? ' · 有异常记录' : ''} · ${time(input.at)}`, 'muted'));
    link.onclick = event => {
      event.preventDefault(); selected = { id: input.id, uid: input.uid }; lastDetail = ''; saveLocation(true);
      void refresh().then(() => { if (matchMedia('(max-width: 760px)').matches) $('input-heading').scrollIntoView(); });
    };
    $('input-list').append(link);
  }
  $('input-count').textContent = `${result.total} 个 Input · 每页 ${result.pageSize} 条`;
  $('input-page').textContent = `${result.page} / ${result.pages}`;
  $<HTMLButtonElement>('input-previous').disabled = result.page <= 1;
  $<HTMLButtonElement>('input-next').disabled = result.page >= result.pages;
  $('input-list-notice').textContent = result.total ? '' : '没有匹配的 Input。';
}
async function refreshFilters() {
  filtersRequest?.abort(); const controller = new AbortController(); filtersRequest = controller;
  try {
    const result = await request<InputFiltersView>('/inputs/filters', { signal: controller.signal });
    if (controller.signal.aborted) return;
    options('input-origin', '全部来源类型', result.origins);
    options('input-connector', '全部 Connector', result.connectors);
    options('input-source', '全部观察源', result.sources);
  } catch (error) { if (!controller.signal.aborted) $('input-list-notice').textContent = '筛选项更新失败：' + errorMessage(error); }
}
function renderDetail(detail: InputDetailView) {
  // Keep open evidence panels and text selection stable during polling.
  const encoded = JSON.stringify(detail);
  if (encoded === lastDetail) return;
  lastDetail = encoded;
  $('input-heading').textContent = detail.label;
  $('input-detail-notice').textContent = '';
  $('input-detail-content').hidden = false;
  $('input-facts').replaceChildren();
  const input = detail.input;
  for (const [label, value] of [
    ['Input ID', input.metadata.name], ['接收时间', time(input.metadata.creationTimestamp)],
    ['来源', `${input.spec.origin} / ${input.spec.originId}`], ['来源 Topic Key', input.spec.topicKey],
    ['来源地址', input.spec.source && JSON.stringify(input.spec.source)], ['观察源', input.spec.originRef && `${input.spec.originRef.kind} / ${input.spec.originRef.name}`],
  ] as const) if (value) $('input-facts').append(node('dt', label), node('dd', value));
  if (input.spec.sender) {
    const link = node('a', '查看人物资料'); link.href = '/people?' + new URLSearchParams({ person: input.spec.sender.name, uid: input.spec.sender.uid! });
    const value = node('dd'); value.append(link); $('input-facts').append(node('dt', '发送者'), value);
  }
  const observation = $('input-observation'); observation.replaceChildren();
  const link = (title: string, path: string, extra: Record<string, string> = {}) => {
    const anchor = node('a', title); anchor.href = path + '?' + new URLSearchParams({ id: input.metadata.name, uid: input.metadata.uid, ...extra });
    anchor.target = '_blank'; anchor.rel = 'noopener'; observation.append(anchor, document.createTextNode(' · '));
  };
  link('查看 JobView', '/inputs/job', { format: 'html' });
  link('下载 Job JSON', '/inputs/job', { download: '1' });
  for (const agent of detail.sessions) {
    link(`${agent.harness} Session`, '/inputs/session', { ...agent, format: 'html' });
    link('下载 Session JSON', '/inputs/session', { ...agent, download: '1' });
  }
  $('input-text').textContent = input.spec.text;
  $('input-evidence').textContent = JSON.stringify(input.spec.observation ?? {}, null, 2);
  $('input-status').textContent = JSON.stringify({ status: input.status, outputs: detail.outputs }, null, 2);
  $('input-attempts').textContent = detail.routeAttempts ? `路由尝试次数：${detail.routeAttempts}` : '';
  $('input-output-notice').textContent = detail.outputCount ? `${detail.outputCount} 条显式关联的 Output。` : '尚无显式关联的 Output；Input 可以被静默处理。';
  $('input-timeline').replaceChildren(...detail.timeline.map(entry => {
    const item = node('li', undefined, 'timeline-entry'); item.dataset.stage = entry.stage;
    item.append(node('span', time(entry.at), 'muted'), node('strong', entry.title));
    if (entry.consumer) {
      const consumer = entry.consumer;
      if (consumer.available && consumer.topicId) {
        const link = node('a', `${consumer.ref.kind} · ${consumer.label}`); link.href = '/?topic=' + encodeURIComponent(consumer.topicId); item.append(link);
      } else item.append(node('span', `${consumer.ref.kind} · ${consumer.label}${consumer.available ? '' : '（已删除或不可用）'}`, 'muted'));
    }
    if (entry.status) item.append(node('span', statusLabels[entry.status] ?? entry.status, 'input-stage-status'));
    if (entry.text) item.append(node('p', entry.text));
    if (entry.executionId) {
      const execution = node('details'); execution.append(node('summary', '执行关联'), node('code', entry.executionId)); item.append(execution);
    }
    return item;
  }));
}
function schedule() { timer = setTimeout(() => { if (document.hidden) schedule(); else void refresh(); }, 5000); }
async function refresh() {
  const token = ++generation;
  clearTimeout(timer); active?.abort(); active = new AbortController();
  const signal = active.signal;
  try {
    const result = await request<InputListView>('/inputs/list?' + query, { signal });
    if (token !== generation) return;
    page = result; query.set('page', String(result.page)); saveLocation(); renderList(result);
    if (selected) {
      try {
        const detail = await request<InputDetailView>('/inputs/detail?' + new URLSearchParams({ id: selected.id, ...(selected.uid ? { uid: selected.uid } : {}) }), { signal });
        if (token !== generation) return;
        renderDetail(detail);
      } catch (error) {
        if (token !== generation) return;
        $('input-heading').textContent = 'Input 不可用';
        $('input-detail-notice').textContent = errorMessage(error); $('input-detail-content').hidden = true; lastDetail = '';
      }
    } else {
      $('input-heading').textContent = '选择一个 Input'; $('input-detail-content').hidden = true;
      $('input-detail-notice').textContent = '选择左侧记录，查看从接收到路由、研判和办理的处理痕迹。'; lastDetail = '';
    }
  } catch (error) { if (token === generation) $('input-list-notice').textContent = errorMessage(error); }
  finally { if (token === generation) schedule(); }
}
$('input-filters').onsubmit = event => {
  event.preventDefault(); query.set('page', '1');
  const q = $<HTMLInputElement>('input-search').value.trim(); if (q) query.set('q', q); else query.delete('q');
  for (const [key, id] of Object.entries(selects)) {
    const value = $<HTMLSelectElement>(id).value; if (value === '*') query.delete(key); else query.set(key, value);
  }
  const origin = $<HTMLSelectElement>('input-origin').value;
  if (origin === '*') { query.delete('origin'); query.delete('originId'); }
  else { const split = origin.indexOf(':'); query.set('origin', origin.slice(0, split)); query.set('originId', origin.slice(split + 1)); }
  if ($<HTMLInputElement>('input-errors').checked) query.set('errors', 'true'); else query.delete('errors');
  selected = undefined; saveLocation(true); void refresh();
};
$('input-reset').onclick = () => { history.pushState(null, '', '/inputs'); loadLocation(); void refresh(); void refreshFilters(); };
$('input-refresh').onclick = () => { void refresh(); void refreshFilters(); };
$('input-previous').onclick = () => { if (page && page.page > 1) { query.set('page', String(page.page - 1)); saveLocation(true); void refresh(); } };
$('input-next').onclick = () => { if (page && page.page < page.pages) { query.set('page', String(page.page + 1)); saveLocation(true); void refresh(); } };
window.addEventListener('popstate', () => { loadLocation(); lastDetail = ''; void refresh(); });
window.addEventListener('pagehide', () => { generation++; clearTimeout(timer); active?.abort(); filtersRequest?.abort(); });
window.addEventListener('pageshow', event => { if (event.persisted) { void refresh(); void refreshFilters(); } });
loadLocation(); void refresh(); void refreshFilters();
