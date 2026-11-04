import './style.css';
import { byId as $, element as node } from '../shared/dom.ts';
import { request, errorMessage } from '../shared/http.ts';
import type { OutputListView, OutputDetailView, OutputFiltersView } from '../../api/types.ts';

let page: OutputListView | undefined, selected: { id: string; uid?: string } | undefined;
let generation = 0, timer: ReturnType<typeof setTimeout> | undefined, active: AbortController | undefined;
let lastDetail = '', lastList = '';
let filtersRequest: AbortController | undefined;
const query = new URLSearchParams();
const selects = { topicUid: 'output-topic', receiverUid: 'output-receiver', addressUid: 'output-address', phase: 'output-phase', disclosure: 'output-disclosure' } as const;
function time(at?: string) {
  if (!at) return '时间未记录';
  return Number.isFinite(Date.parse(at)) ? new Date(at).toLocaleString() : at;
}
const statusLabels = { pending: '待投递', sending: '投递中', delivered: '已送达', failed: '投递失败', uncertain: '投递待核对', cancelled: '已取消' };
const disclosureLabels = { pending: '待检查', allowed: '允许', denied: '拒绝原内容外发' };
function localTime(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
}

function loadLocation() {
  const params = new URL(location.href).searchParams;
  for (const key of [...query.keys()]) query.delete(key);
  for (const key of ['page', 'pageSize', 'q', 'topicUid', 'receiverUid', 'addressUid', 'phase', 'disclosure', 'from', 'to']) if (params.has(key)) query.set(key, params.get(key)!);
  selected = params.get('output') ? { id: params.get('output')!, uid: params.get('uid') ?? undefined } : undefined;
  $<HTMLInputElement>('output-search').value = query.get('q') ?? '';
  for (const key of ['from', 'to']) $<HTMLInputElement>('output-' + key).value = localTime(query.get(key));
  for (const [key, id] of Object.entries(selects)) selectValue(id, query.get(key) ?? '*');
}
function selectValue(id: string, value: string) {
  const select = $<HTMLSelectElement>(id);
  if (![...select.options].some(o => o.value === value)) select.add(new Option(value || '未记录', value));
  select.value = value;
}
function saveLocation(push = false) {
  const params = new URLSearchParams(query);
  if (selected) { params.set('output', selected.id); if (selected.uid) params.set('uid', selected.uid); }
  history[push ? 'pushState' : 'replaceState'](null, '', '/outputs' + (params.size ? '?' + params : ''));
}
function options(id: string, allLabel: string, items: { value: string; label: string }[]) {
  const select = $<HTMLSelectElement>(id), value = select.value;
  select.replaceChildren(new Option(allLabel, '*'), ...items.map(item => new Option(item.label, item.value)));
  selectValue(id, value);
}
/** @spec Successful polls clear previous request errors even when cached list content is unchanged. */
function renderList(result: OutputListView) {
  $('output-list-notice').textContent = result.total ? '' : '没有匹配的 Output。';
  const signature = JSON.stringify({ result, query: query.toString(), selected });
  if (signature === lastList) return;
  lastList = signature;
  $('output-list').replaceChildren();
  for (const output of result.items) {
    const link = node('a', undefined, 'list-link');
    const params = new URLSearchParams(query); params.set('output', output.id); params.set('uid', output.uid);
    link.href = '/outputs?' + params;
    if (selected?.id === output.id) link.setAttribute('aria-current', 'page');
    link.append(node('strong', output.preview), node('span', `${output.topic.label} · ${time(output.at)}`, 'muted'),
      node('span', `原定：${output.receivers.map(r => r.label).join('、') || '未指定个人'} → ${output.address.label}`, 'muted'),
      node('span', `披露：${disclosureLabels[output.disclosure]} · 投递：${statusLabels[output.phase]}`, 'muted'));
    if (output.actualAddress && output.actualAddress.ref.uid !== output.address.ref.uid)
      link.append(node('span', `实际地址：${output.actualAddress.label}`, 'muted'));
    if (output.wait) link.append(node('span', `${output.wait.label} · ${time(output.wait.until)}`, 'muted'));
    link.onclick = event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); selected = { id: output.id, uid: output.uid }; lastDetail = ''; saveLocation(true);
      void refresh().then(() => { if (matchMedia('(max-width: 760px)').matches) $('output-heading').scrollIntoView(); });
    };
    $('output-list').append(link);
  }
  $('output-count').textContent = String(result.total);
  $('output-count').setAttribute('aria-label', `${result.total} 个 Output`);
  $('output-page').textContent = `${result.page} / ${result.pages}`;
  $<HTMLButtonElement>('output-previous').disabled = result.page <= 1;
  $<HTMLButtonElement>('output-next').disabled = result.page >= result.pages;
}
async function refreshFilters() {
  filtersRequest?.abort(); const controller = new AbortController(); filtersRequest = controller;
  try {
    const result = await request<OutputFiltersView>('/outputs/filters', { signal: controller.signal });
    if (controller.signal.aborted) return;
    options('output-topic', '全部 Topic', result.topics);
    options('output-receiver', '全部接收人', result.receivers);
    options('output-address', '全部地址', result.addresses);
  } catch (error) { if (!controller.signal.aborted) $('output-list-notice').textContent = '筛选项更新失败：' + errorMessage(error); }
}
type RefView = OutputDetailView['topic'];
function refNode(ref: RefView) {
  const label = `${ref.label}${ref.available ? '' : '（已删除或不可用）'}`;
  if (ref.href) { const link = node('a', label); link.href = ref.href; return link; }
  return node('span', label);
}
function fact(section: string, label: string, value: string | Node | Node[] | undefined) {
  if (value === undefined) return;
  const dd = node('dd');
  if (typeof value === 'string') dd.textContent = value;
  else if (Array.isArray(value)) value.forEach((item, i) => { if (i) dd.append(document.createTextNode('、')); dd.append(item); });
  else dd.append(value);
  $(section).append(node('dt', label), dd);
}
function renderDetail(detail: OutputDetailView) {
  const encoded = JSON.stringify(detail);
  if (encoded === lastDetail) return;
  lastDetail = encoded;
  $('output-heading').textContent = 'Output · ' + detail.id;
  $('output-detail-notice').textContent = ''; $('output-detail-content').hidden = false;
  for (const id of ['facts', 'intent', 'check', 'delivery', 'provenance']) $('output-' + id).replaceChildren();
  fact('output-facts', '创建时间', time(detail.at));
  fact('output-facts', 'Topic', refNode(detail.topic));
  fact('output-facts', '投递状态', statusLabels[detail.phase]);
  $('output-text').textContent = detail.text;
  $('output-think').textContent = detail.process;
  $('output-delivered-think').textContent = detail.delivery?.process ?? '';
  fact('output-facts', '生成状态', detail.stream.phase);
  fact('output-delivery', '已确认片段', String(detail.delivery?.confirmedSeq ?? 0));
  fact('output-intent', '接收人', detail.receivers.length ? detail.receivers.map(refNode) : '未指定个人');
  fact('output-intent', '地址', refNode(detail.address));
  fact('output-check', '检查结果', disclosureLabels[detail.disclosure]);
  fact('output-check', '检查时间', detail.disclosureDetail && time(detail.disclosureDetail.checkedAt));
  fact('output-check', '原因', detail.disclosureDetail?.reason);
  fact('output-delivery', '状态', statusLabels[detail.phase]);
  fact('output-delivery', '累计调用次数', String(detail.attempts));
  const operation = detail.delivery?.operation;
  if (operation) {
    fact('output-delivery', '当前操作尝试次数', `${operation.attempts} / ${operation.maxAttempts}`);
    fact('output-delivery', '当前投递片段', `${operation.snapshot.lastSeq} · ${operation.snapshot.phase}`);
  }
  if (detail.preparationAttempts) fact('output-delivery', '连续准备失败次数', String(detail.preparationAttempts));
  if (detail.wait) { fact('output-delivery', '等待原因', detail.wait.label); fact('output-delivery', '预计重试', time(detail.wait.until)); }
  fact('output-delivery', '最近错误', detail.lastError);
  fact('output-delivery', '送达时间', detail.deliveredAt && time(detail.deliveredAt));
  fact('output-delivery', '回执', detail.receipt && `${detail.receipt.scope} / ${detail.receipt.id}`);
  $('output-delivered-text').hidden = !detail.delivery;
  $('output-delivered-text').textContent = detail.delivery?.text ?? '';
  if (detail.delivery) {
    fact('output-delivery', '实际地址', detail.actualAddress && refNode(detail.actualAddress));
    fact('output-delivery', '投递位置', JSON.stringify(detail.delivery.target));
    fact('output-delivery', '实际接收人', detail.delivery.receivers.length ? detail.delivery.receivers.map(refNode) : '未指定个人');
  } else fact('output-delivery', '实际内容', '尚未准备实际投递内容');
  if (detail.producer) {
    const kind = detail.producer.ref.kind === 'Topic' ? 'Chief' : detail.producer.ref.kind;
    fact('output-provenance', '生成者', [node('span', kind), refNode(detail.producer)]);
  } else fact('output-provenance', '生成者', '未记录');
  fact('output-provenance', 'Execution ID', detail.executionId ?? detail.createdBy?.executionId ?? '未记录');
  if (detail.createdBy) {
    const link = node('a', '查看生成 Session');
    link.href = '/outputs/session?' + new URLSearchParams({ id: detail.id, uid: detail.uid }); link.target = '_blank'; link.rel = 'noopener';
    fact('output-provenance', '执行记录', link); fact('output-provenance', 'Tool Call ID', detail.createdBy.toolCallId);
  }
  fact('output-provenance', '关联 Input', detail.inputs.length ? detail.inputs.map(input => {
    if (input.href) { const link = node('a', input.id); link.href = input.href; return link; }
    return node('span', `${input.id}（已删除或未记录精确身份）`);
  }) : '无显式关联的 Input');
  $('output-notes').textContent = detail.notes.length ? JSON.stringify(detail.notes, null, 2) : '无引用的 Note';
}
function schedule() { timer = setTimeout(() => { if (document.hidden) schedule(); else void refresh(); }, 5000); }
async function refresh() {
  const token = ++generation;
  clearTimeout(timer); active?.abort(); active = new AbortController();
  const signal = active.signal;
  try {
    const result = await request<OutputListView>('/outputs/list?' + query, { signal });
    if (token !== generation) return;
    page = result; query.set('page', String(result.page)); saveLocation(); renderList(result);
    if (selected) {
      try {
        const detail = await request<OutputDetailView>('/outputs/detail?' + new URLSearchParams({ id: selected.id, ...(selected.uid ? { uid: selected.uid } : {}) }), { signal });
        if (token !== generation) return;
        renderDetail(detail);
      } catch (error) {
        if (token !== generation) return;
        $('output-heading').textContent = 'Output 不可用';
        $('output-detail-notice').textContent = errorMessage(error); $('output-detail-content').hidden = true; lastDetail = '';
      }
    } else {
      $('output-heading').textContent = '选择一个 Output'; $('output-detail-content').hidden = true;
      $('output-detail-notice').textContent = '选择左侧记录，查看生成内容、披露检查与实际投递。'; lastDetail = '';
    }
  } catch (error) { if (token === generation) $('output-list-notice').textContent = errorMessage(error); }
  finally { if (token === generation) schedule(); }
}
$('output-filters').onsubmit = event => {
  event.preventDefault(); query.set('page', '1');
  const q = $<HTMLInputElement>('output-search').value.trim(); if (q) query.set('q', q); else query.delete('q');
  for (const [key, id] of Object.entries(selects)) {
    const value = $<HTMLSelectElement>(id).value; if (value === '*') query.delete(key); else query.set(key, value);
  }
  for (const key of ['from', 'to']) {
    const value = $<HTMLInputElement>('output-' + key).value;
    if (value) query.set(key, new Date(value).toISOString()); else query.delete(key);
  }
  selected = undefined; saveLocation(true); void refresh();
};
$('output-reset').onclick = () => { history.pushState(null, '', '/outputs'); loadLocation(); void refresh(); void refreshFilters(); };
$('output-refresh').onclick = () => { void refresh(); void refreshFilters(); };
$('output-previous').onclick = () => { if (page && page.page > 1) { query.set('page', String(page.page - 1)); saveLocation(true); void refresh(); } };
$('output-next').onclick = () => { if (page && page.page < page.pages) { query.set('page', String(page.page + 1)); saveLocation(true); void refresh(); } };
window.addEventListener('popstate', () => { loadLocation(); lastDetail = ''; void refresh(); });
window.addEventListener('pagehide', () => { generation++; clearTimeout(timer); active?.abort(); filtersRequest?.abort(); });
window.addEventListener('pageshow', event => { if (event.persisted) { void refresh(); void refreshFilters(); } });
loadLocation(); void refresh(); void refreshFilters();
