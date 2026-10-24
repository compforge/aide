import "./style.css";
import { byId as $, element } from "../shared/dom.ts";
import { request, errorMessage } from "../shared/http.ts";
import type { ChannelSettingsView, ChannelSettingsChange } from "../../channel/settings.ts";
import type { PersonView } from "../../api/types.ts";
let view: ChannelSettingsView | undefined;
let people: PersonView[] = [];
let busy = false;
const value = (id: string) => $<HTMLInputElement>(id).value.trim();
function identities() {
  const select = $<HTMLSelectElement>("known-me");
  select.replaceChildren(new Option("选择已知身份，或在下方填写", ""));
  for (const person of people.filter(p => p.isMe)) for (const identity of person.spec.identities) {
    if (identity.provider === "lark" && identity.scope === value("channel-app")) select.add(new Option(`${person.spec.name} · ${identity.id}`, identity.id));
  }
}
function render() {
  if (!view) return;
  const settings = view;
  $("channel-status").textContent = view.restartRequired ? `配置已保存，重启 Aide 后生效。当前默认渠道：${view.activeDefaultChannel}。` : "配置与当前启动快照一致；实际连接和投递结果请查看运行日志。";
  const select = $<HTMLSelectElement>("default-channel");
  select.replaceChildren(new Option("Web · 本地页面", "web"));
  for (const channel of view.channels.filter(c => c.enabled)) select.add(new Option(channel.label, channel.id));
  select.value = view.defaultChannel;
  $("channel-list").replaceChildren(...view.channels.map(channel => {
    const card = element("article", undefined, "channel-card");
    card.append(element("h3", channel.label + (channel.id === settings.defaultChannel ? " · 默认沟通渠道" : "")),
      element("p", `${channel.id} · ${channel.enabled ? "启用" : "停用"}${channel.changed ? " · 待重启生效" : ""}`),
      element("p", `Aide：${channel.appId} · 密钥${channel.secretConfigured ? "已配置" : "缺失"}`),
      element("p", `Me：${channel.me?.openId ?? "未在渠道配置中指定；默认联系我时需要该应用下的 Me 身份"}`));
    const edit = element("button", "编辑"); edit.type = "button"; edit.onclick = () => open(channel.id); card.append(edit);
    return card;
  }));
}
async function loadPeople() {
  try {
    people = await request<PersonView[]>("/persons");
    $("person-warning").textContent = "";
  } catch {
    people = [];
    $("person-warning").textContent = "人物列表暂时无法加载，仍可手动填写 Me 的 open_id。点击刷新可重试。";
  }
  identities();
}
async function load() {
  void loadPeople();
  view = await request<ChannelSettingsView>("/channels/config");
  render();
}
function open(id?: string) {
  if (!view) return;
  const channel = view.channels.find(c => c.id === id);
  $<HTMLFormElement>("channel-form").reset();
  $("editor").hidden = false; $("editor-heading").textContent = channel ? "编辑渠道" : "新增渠道";
  $<HTMLInputElement>("channel-id").value = id ?? "";
  $<HTMLInputElement>("channel-id").disabled = Boolean(channel);
  $<HTMLInputElement>("channel-label").value = channel?.label ?? "";
  $<HTMLInputElement>("channel-app").value = channel?.appId ?? "";
  $<HTMLInputElement>("channel-me").value = channel?.me?.openId ?? "";
  $<HTMLInputElement>("channel-enabled").checked = channel?.enabled ?? true;
  $<HTMLInputElement>("channel-secret").required = !channel;
  identities(); $("editor-heading").scrollIntoView({ block: "nearest" });
}
async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true; $("channel-error").textContent = "";
  const controls = [...document.querySelectorAll<HTMLButtonElement>("button")]; controls.forEach(b => b.disabled = true);
  try { await action(); } catch (error) { $("channel-error").textContent = errorMessage(error); }
  finally { busy = false; controls.forEach(b => b.disabled = !view && b.id !== "refresh"); }
}
async function save(change: ChannelSettingsChange) { view = await request<ChannelSettingsView>("/channels/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(change) }); render(); }
$("refresh").onclick = () => void run(load);
$("add-channel").onclick = () => open();
$("cancel-edit").onclick = () => { $("editor").hidden = true; };
$("channel-app").oninput = identities;
$("known-me").onchange = () => { $<HTMLInputElement>("channel-me").value = $<HTMLSelectElement>("known-me").value; };
$("save-default").onclick = () => void run(async () => {
  if (!view) throw new Error("请先刷新加载渠道配置。");
  await save({ operation: "default", revision: view.revision, id: value("default-channel") });
});
$("channel-form").onsubmit = event => {
  event.preventDefault();
  void run(async () => {
    if (!view) throw new Error("请先刷新加载渠道配置。");
    await save({ operation: "save", revision: view.revision, id: value("channel-id"), channel: {
      kind: "lark", label: value("channel-label"), enabled: $<HTMLInputElement>("channel-enabled").checked,
      appId: value("channel-app"), ...(value("channel-secret") ? { appSecret: value("channel-secret") } : {}),
      ...(value("channel-me") ? { me: { openId: value("channel-me") } } : {}),
    } });
    $<HTMLInputElement>("channel-secret").value = ""; $("editor").hidden = true;
  });
};
void run(load);
