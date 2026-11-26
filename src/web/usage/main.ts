import "./style.css";
import { byId, element } from "../shared/dom.ts";
import { request, errorMessage } from "../shared/http.ts";
import type { UsageReport } from "../../../plugins/personal/observation/usage.ts";
import type { UsageCall } from "../../../plugins/personal/observation/usage-store.ts";

const roleName = (role: string) => role.charAt(0).toUpperCase() + role.slice(1);
const period = byId<HTMLSelectElement>("window"), role = byId<HTMLSelectElement>("role"), model = byId<HTMLSelectElement>("model");
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
  if (role.value) q.set("role", role.value);
  if (model.value) {
    const [provider,id] = JSON.parse(model.value);
    q.set("provider",provider); q.set("model",id);
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
async function load() {
  const rev = ++revision;
  detailRevision++; detail.replaceChildren(); report.replaceChildren(); notice.textContent = "正在读取 Usage…";
  try {
    const data = await request<UsageReport>("/usage/report?" + params());
    if (rev !== revision) return;
    if (!role.options[1]) for (const item of data.roles) role.add(new Option(roleName(item.role), item.role));
    if (!model.value) {
      model.length = 1;
      for (const m of data.models) model.add(new Option(m.provider + " / " + m.model, JSON.stringify([m.provider,m.model])));
    }
    notice.textContent = stamp(data.since) + " — " + stamp(data.until);
    report.append(heading("角色"), table(["角色", ...columns], data.roles.filter(r => !role.value || role.value === r.role)
      .sort((a,b) => b.total-a.total).map(r => [r.calls || r.auxiliaryRecords ? roleName(r.role) : roleName(r.role) + " · 未观测到调用", ...metrics(r)])));
    if ((!role.value || role.value === "route") && data.routeInputs !== null)
      report.append(element("p","Route 成功处理 " + number(data.routeInputs) + " 个 Input，平均每个 Input " + number(data.tokensPerRouteInput) + " tokens。"));
    if (data.origins.length) report.append(heading("Chief 触发来源"),table(["来源", ...columns],data.origins.map(r => [label(r.origin), ...metrics(r)])));
    if (data.models.length) report.append(heading("模型"),table(["Provider / 模型", ...columns],data.models.map(m => [m.provider + " / " + m.model,...metrics(m)])));
    report.append(heading("Usage 最高的 Session"));
    if (!data.sessions.length) { report.append(element("p","所选范围内没有观测到调用。")); return; }
    report.append(table(["Session","角色","调用","Tokens"],data.sessions.map(s => {
      const link = element("a",s.id); link.href = "#calls";
      link.onclick = e => { e.preventDefault(); void calls(s); };
      return [link,roleName(s.role),number(s.calls),number(s.total)];
    })));
  } catch (e) { if (rev === revision) notice.textContent = errorMessage(e); }
}
document.querySelector("form")!.onsubmit = event => { event.preventDefault(); void load(); };
for (const select of [period,role,model]) select.onchange = () => { if (select !== model) model.value = ""; void load(); };
void load();
