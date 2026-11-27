import "./style.css";
import { byId, element } from "../shared/dom.ts";
import { request, errorMessage } from "../shared/http.ts";
import type { UsageReport } from "../../../plugins/personal/observation/usage.ts";
import type { UsageCall } from "../../../plugins/personal/observation/usage-store.ts";

const roleName = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);
const query = new URLSearchParams(location.search);
const view = query.get("view") ?? "overview";
const period = byId<HTMLSelectElement>("window");
period.value = query.get("window") === "7d" ? "7d" : "24h";
const role = view === "roles" ? query.get("role") : null;
const model = view === "models" ? null : query.get("model");
const provider = model && query.get("provider");
const report = byId("report"), detail = byId("calls"), notice = byId("notice");
const fmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const number = (n: number | null) => n === null ? "—" : fmt.format(n);
const stamp = (n: number) => new Date(n).toLocaleString("zh-CN", { hour12: false });
const label = (s: string) => ({ business: "普通 Input", mixed: "混合来源", unknown: "未归因" })[s] ?? s;
const heading = (s: string) => element("h3", s);
type Cell = string | Node;
function table(headers: string[], rows: Cell[][]) {
  const sheet = element("div", undefined, "sheet"), t = element("table"), header = t.createTHead().insertRow();
  for (const name of headers) header.append(element("th", name));
  const body = t.createTBody();
  for (const cells of rows) {
    const row = body.insertRow();
    for (const cell of cells) row.insertCell().append(cell);
  }
  sheet.append(t);
  return sheet;
}
const columns = ["Tokens 合计","调用", "Session", "调用 / Session", "Input", "Cache read", "Cache write", "Output", "单次输入 P50", "P95", "已报告 Usage / 调用","其中辅助 tokens"];
function metrics(r: Pick<UsageReport["roles"][number], "total" | "calls" | "sessions" | "input" | "output" | "cacheRead" | "cacheWrite" | "median" | "p95" | "covered" | "auxiliaryTokens">) {
  return [number(r.total), number(r.calls), number(r.sessions), number(r.sessions ? r.calls/r.sessions : null), number(r.input),
    number(r.cacheRead), number(r.cacheWrite), number(r.output), number(r.median), number(r.p95), r.covered + " / " + r.calls,number(r.auxiliaryTokens)];
}
let revision = 0, detailRevision = 0;
function params() {
  const q = new URLSearchParams({ window: period.value });
  if (role) q.set("role", role);
  if (provider && model) {
    q.set("provider", provider);
    q.set("model", model);
  }
  return q;
}
async function calls(s: UsageReport["sessions"][number], page = 1) {
  const rev = ++detailRevision;
  const q = params();
  q.set("id",s.id); q.set("role",s.role); q.set("page",String(page));
  try {
    const data = await request<{ items: UsageCall[]; total: number; pageSize: number }>("/usage/calls?" + q);
    if (rev !== detailRevision) return;
    const view = element("a","打开 SessionView");
    view.href = "/usage/session?" + new URLSearchParams({ id: s.id, role: s.role });
    view.target = "_blank"; view.rel = "noopener";
    detail.replaceChildren(heading(s.role + " · " + s.id), view, table(["记录时间","类型","Provider / 模型","来源","Input","Cache read","Cache write","Output"],
      data.items.map(c => [stamp(c.at), c.auxiliary ?? "模型响应", c.provider + " / " + c.model, c.origin ? label(c.origin) : "—",
        ...[c.tokens?.input,c.tokens?.cacheRead,c.tokens?.cacheWrite,c.tokens?.output].map(n => number(n ?? null))])));
    for (const [text,next] of [["上一页",page-1],["下一页",page+1]] as const) {
      const button = element("button",text); button.disabled = next < 1 || (next-1)*data.pageSize >= data.total;
      button.onclick = () => void calls(s,next); detail.append(button);
    }
    detail.scrollIntoView({ block: "start" });
  } catch (e) { if (rev === detailRevision) detail.textContent = errorMessage(e); }
}
type View = "overview" | "roles" | "models";
function viewUrl(target: View, selectedRole?: string, selectedProvider = provider, selectedModel = model) {
  const q = new URLSearchParams({ window: period.value, view: target });
  if (target === "roles" && selectedRole) q.set("role", selectedRole);
  if (target !== "models" && selectedProvider && selectedModel) {
    q.set("provider", selectedProvider);
    q.set("model", selectedModel);
  }
  return "/usage?" + q;
}
function link(text: string, href: string) {
  const anchor = element("a", text);
  anchor.href = href;
  return anchor;
}
function roleTable(data: UsageReport) {
  const total = data.roles.reduce((sum, r) => sum + r.total, 0);
  return table(["角色", "Tokens 合计", "占比", "调用", "Session", "单次输入 P50", "P95"],
    [...data.roles].sort((a,b) => b.total - a.total).map(r => [
      link(roleName(r.role), viewUrl("roles", r.role)), number(r.total), total ? number(100 * r.total / total) + "%" : "—",
      number(r.calls), number(r.sessions), number(r.median), number(r.p95),
    ]));
}
function trend(data: UsageReport) {
  const figure = element("figure");
  figure.append(element("figcaption", "已观测 tokens / 分钟"));
  if (!data.minutes.length) {
    figure.append(element("p", "所选范围内没有已报告的用量。", "muted"));
    return figure;
  }
  const peak = data.minutes.reduce((a,b) => a.tokens >= b.tokens ? a : b);
  figure.append(element("p", "峰值 " + number(peak.tokens) + " · " + stamp(peak.at)));
  const ns = "http://www.w3.org/2000/svg";
  const chart = document.createElementNS(ns, "svg");
  chart.setAttribute("viewBox", "0 0 1000 80");
  chart.setAttribute("preserveAspectRatio", "none");
  chart.setAttribute("aria-hidden", "true");
  const bars = document.createElementNS(ns, "path");
  const start = Math.floor(data.since / 60_000);
  const span = Math.floor(data.until / 60_000) - start + 1;
  bars.setAttribute("d", data.minutes.map(({ at, tokens }) => {
    const x = (Math.floor(at / 60_000) - start + 0.5) / span * 1000;
    return "M" + x + " 80v-" + (tokens / peak.tokens * 78);
  }).join(" "));
  chart.append(bars);
  const axis = element("div", undefined, "axis");
  axis.append(element("span", stamp(data.since)), element("span", stamp(data.until)));
  figure.append(chart, axis);
  return figure;
}
function overview(data: UsageReport) {
  const totals = element("dl", undefined, "totals");
  for (const [key, title] of [["total","已观测 tokens"],["calls","模型调用"]] as const) {
    const item = element("div");
    item.append(element("dt", title), element("dd", number(data.roles.reduce((sum,r) => sum + r[key], 0))));
    totals.append(item);
  }
  report.append(totals, trend(data), heading("角色用量"), roleTable(data));
}
function roles(data: UsageReport) {
  const selected = data.roles.find(r => r.role === role);
  if (!selected) {
    report.append(heading("角色用量"), roleTable(data));
    return;
  }
  report.append(link("全部角色", viewUrl("roles")), heading(roleName(selected.role)),
    table(["角色", ...columns], [[roleName(selected.role), ...metrics(selected)]]), trend(data));
  if (role === "chief" && data.origins.length) {
    report.append(heading("Chief 触发来源"), table(["来源", ...columns],
      [...data.origins].sort((a,b) => b.total - a.total).map(r => [label(r.origin), ...metrics(r)])));
  }
  if (role === "route" && data.routeInputs) {
    report.append(element("p", "Route Agent 成功路由 " + number(data.routeInputs) + " 个 Input，平均每个 Input " + number(data.tokensPerRouteInput) + " tokens。"));
  }
  report.append(heading("用量最高的 Session"));
  if (!data.sessions.length) {
    report.append(element("p", "所选范围内没有观测到 Session。"));
    return;
  }
  report.append(table(["Session", "调用", "Tokens"], data.sessions.map(s => {
    const anchor = link(s.id, "#calls");
    anchor.onclick = e => { e.preventDefault(); void calls(s); };
    return [anchor, number(s.calls), number(s.total)];
  })));
}
function models(data: UsageReport) {
  report.append(heading("模型用量"));
  if (!data.models.length) {
    report.append(element("p", "所选范围内没有观测到模型。"));
    return;
  }
  report.append(table(["Provider / 模型", ...columns], [...data.models].sort((a,b) => b.total - a.total).map(m => [
    link(m.provider + " / " + m.model, viewUrl("roles", undefined, m.provider, m.model)), ...metrics(m),
  ])));
}
async function load() {
  const rev = ++revision;
  detailRevision++;
  detail.replaceChildren();
  report.replaceChildren();
  notice.textContent = "正在读取 Usage…";
  try {
    const data = await request<UsageReport>("/usage/report?" + params());
    if (rev !== revision) return;
    if (view !== "models") {
      const choices = byId<HTMLSelectElement>("model");
      const selected = provider && model ? JSON.stringify([provider, model]) : "";
      const options = new Map(data.modelOptions.map(m => [JSON.stringify([m.provider, m.model]), m.provider + " / " + m.model]));
      if (selected && !options.has(selected)) options.set(selected, provider + " / " + model);
      choices.replaceChildren(new Option("全部模型", ""));
      for (const [key, name] of [...options].sort((a,b) => a[1].localeCompare(b[1]))) choices.add(new Option(name, key));
      choices.value = selected;
    }
    notice.textContent = stamp(data.since) + " — " + stamp(data.until);
    if (view === "roles") roles(data);
    else if (view === "models") models(data);
    else overview(data);
  } catch (e) { if (rev === revision) notice.textContent = errorMessage(e); }
}
const currentView = view === "models" || view === "roles" ? view : "overview";
for (const anchor of document.querySelectorAll<HTMLAnchorElement>("#views a")) {
  const target = anchor.dataset.view as View;
  anchor.href = viewUrl(target, target === currentView ? role ?? undefined : undefined);
  if (target === currentView) anchor.setAttribute("aria-current", "page");
  else anchor.removeAttribute("aria-current");
}
byId("model-filter").hidden = currentView === "models";
const modelSelect = byId<HTMLSelectElement>("model");
modelSelect.onchange = () => {
  const [nextProvider, nextModel] = modelSelect.value ? JSON.parse(modelSelect.value) : [null, null];
  location.assign(viewUrl(currentView, role ?? undefined, nextProvider, nextModel));
};
document.querySelector("form")!.onsubmit = event => { event.preventDefault(); void load(); };
period.onchange = () => location.assign(viewUrl(currentView, role ?? undefined));
void load();
