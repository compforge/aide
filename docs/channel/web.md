# Web Channel

Web 是 Aide 的浏览器 Channel，提供会话导航、聊天、工作列表与用户交互。与 Feishu 的共同边界见 [Channel](README.md)。

## 前后端分工

`src/web/` 放浏览器页面、脚本、样式与 Markdown 渲染。`src/api/` 提供 HTTP 路由、输入校验、响应与 SSE，handler 通过应用提供的接口调用 Core / Personal 能力；Work 生命周期规则由 WorkService 负责。共享的消息和执行展示投影仍在 `src/channel/`，供 Web 与 Feishu 使用。

## 消息与 Markdown

用户消息、Aide 正式回复，以及执行过程中的思考与文字输出使用同一 Markdown 渲染器，支持标题、列表、引用、代码块、表格和链接。流式内容按当前完整文本重新解析，历史记录和重连快照使用相同规则。表格与代码块可横向滚动。

浏览器 bundle 内置 markdown-it，关闭原始 HTML 并保留 URL 校验；链接在新页打开，禁用图片语法以避免展示内容主动加载外部资源。工具原始参数与结果保持纯文本。渲染只改变展示，消息和 Ledger 继续保存原文。

## 实时进展与历史

同一 Input 的思考、工具过程和最终答案呈现在一个 Aide 回复块中，回复块整体可折叠，内部包含“思考与执行过程”和“回答”两个可独立展开、收起的区域，与飞书卡片保持相同的展示方式。思考区域默认收起，回答区域默认展开。处理中、待答问题和中断提示的外层默认展开；完成后默认整体收起，只显示状态与首行预览。展开外层即可看到完整答案，仍可单独控制内部两个区域。接收 Input 后显示排队或处理状态，Chief 执行时分别更新两块区域，完成后用正式 Message 替换正文增量，不额外渲染一份答案。问题保留独立的 Core 身份与 pending / answered / cancelled 状态：待答问题显示在回答区，已回答或已取消的问题归入同条回复的过程区，不拼入最终答案或折叠预览。模型未提供思考内容时只显示真实状态，不生成占位思考文本。当前覆盖 Chief 接话过程，Work 的后台执行仍通过事项卡片展示状态。

```text
Pi SDK delta / tool event → Pi Adapter → Core Event → Session Projection
                                                        ↓
Conversation / Input / Message → conversationView → AgentUE UIModel
                                                        ↓
                          PatchEmitter → encodeSse → 浏览器 applyPatch → 网页
```

Pi Adapter 将 `text_delta` / `thinking_delta` 映射到现有 `agent_message_chunk` / `agent_thought_chunk`，消息结束时使用相同 ID 提交完整内容。工具循环的中间发言保持 commentary，只有成功收口的最后答复标为 final。展示进展不改变 Harness 的完成语义，也不触发 Work CRUD。

`src/channel/view.ts` 从已有 Session Projection 选择显式关联当前 Conversation 的 HarnessInvocation 及其 Turn，不发送内部提示词或整个工具原始响应。它生成 `biz: aide.conversation` 的 AgentUE UIModel：`meta.conversation_id` 和 `meta.activity` 表示会话与当前执行状态，正式 `message` 和每个 Turn 对应的 `execution` 按时间排序；同一 Input 的 execution 与正式回复通过 AgentUE 原生 `group_id` 分组，关联来自持久 Input 和 HarnessInvocation，不靠相邻顺序猜测。`thought` / `text` / `tool` 通过 `parent_id` 归属到该 execution，内部保持 Ledger 时间线顺序。不同类别的 ID 有前缀，避免业务消息与执行事件的身份冲突。

`src/api/stream.ts` 使用 SDK 的 `PatchEmitter` 和 `encodeSse`，通过 `GET /stream?conversationId=...` 输出 AgentUE SSE。首次连接与重连发送 `start` 完整快照，之后新增或更正 block 用 `set`，正文增长用 `append`，执行状态变化用 `meta.activity` 的 `set`。完成只改变 execution 状态，不移除其内容；消息插入导致 block 顺序变化时发送新的 `start` 替换模型。

流式变更合并后发送，空闲连接发送 AgentUE `ping`，独立写入的 Work outbox 定期检查。发送阻塞时等待 drain，基于上次已写出的模型计算最新 patch。连接定期以 `end` 正常结束，由 EventSource 自动重连；投影失败发送 `error` 后 `end`。首次投影失败则直接返回 HTTP 500。断开连接清理订阅和计时器，不取消服务端执行；进程退出或网络中断属于传输中断，客户端从新快照恢复。

使用已发布的 `@compforge/agentue` SDK，版本由 lockfile 固定。服务端与浏览器直接引用同一 SDK，不复制协议实现。`src/web/sdk.ts` 仅导出浏览器所需的 `applyPatch` / `parsePatchEvent`，由现有 Bun 在首次请求时打包并缓存，经同源 `/agentue.js` 提供。浏览器按 SDK reducer 更新展示模型，Aide 负责将 block 渲染到页面并保留展开状态、输入焦点和用户浏览历史时的滚动位置。

Core reducer 负责执行事实，AgentUE reducer 负责展示状态，二者职责独立。每次连接的 seq 属于该次交付，不保存 UI patch 日志或按 Last-Event-ID 重放；执行事件仍由既有 Ledger 持久化。

进度不写入 Channel 出站 Message，与 Feishu 的卡片更新分别由各自 Channel 渲染。历史过程直接从既有 Session Ledger 重放形成的投影读取，没有另一份轨迹存储。外层回复块和内部两个区域各自保留同页中的手动展开选择，流式增量、重连及后续消息不会重置用户选择；未手动选择时遵循各区域的默认折叠规则。刷新或重启后仍可展开查看旧轮次，未正常结束的执行标为中断。

`tests/pi-agent.test.ts` 使用真实 Pi SDK 和受控模型 SSE，验证完成前已有思考和正文增量、最终文本不重复。`tests/web-progress.test.ts` 使用真实 Host / Runner / HTTP 和模拟 Harness，下载 HTTP 提供的浏览器 bundle，用其真实 AgentUE reducer 消费 SSE，验证会话隔离、增量更新、重连恢复、断开不取消、最终答复与过程历史同时保留、后续轮次分组、重开 Aide 后的 Ledger 恢复、错误收口，以及进度不进入出站消息。

## 会话导航

网页左栏通过 `GET /conversations` 汇总已有 Conversation 与仅有工作记录的会话范围，展示首条用户消息标题、最近消息摘要和会话 ID，按最近输入或消息时间排序。摘要不包含 Source 观察正文或 Harness 执行细节。默认对话与当前 URL 指定的空会话仍可进入；浏览列表不创建会话。

点击会话导航到 `/?conversation=...`，消息 SSE 与事项查询使用同一个 conversationId。页面导航重新建立该会话的展示快照，刷新和前进后退保留 URL 选择；后台执行不受影响。列表更新失败保留已显示条目并独立提示，不覆盖发送状态。关联问题按 Conversation 展示；未关联会话的宿主 Interaction 保留在本地收件区。

## 工作管理

事项和安排卡片都可手动删除，确认后通过会话范围内的 WorkService 执行。删除保留已有消息，并停止后续跟进；已发起的外部操作可能仍会完成。失败时展示原因，工作版本变化时需刷新后重新确认。

`POST /work/delete` 接收 `id`、`conversationId` 和 `revision`，沿用 Work 工具的删除流程。当前会话找不到工作返回 404，版本不匹配返回 409。

## 本地 HTTP 接口

Web 页面与 HTTP 调用共用服务入口。提交消息后先返回持久化回执，Chief 在后台处理：

```sh
curl -s http://127.0.0.1:7433/messages \
  -H 'content-type: application/json' \
  -d '{"id":"msg-1","conversationId":"me","text":"读取当前项目 README，告诉我如何启动"}'

curl -s 'http://127.0.0.1:7433/conversations'
curl -s 'http://127.0.0.1:7433/messages?conversationId=me&role=all'
curl -s 'http://127.0.0.1:7433/work?conversationId=me'
```

GET `/messages` 默认返回 Aide 消息；`role=all` 包含用户输入，`after=<message-id>` 可增量读取。重投同一入站消息使用相同 id；用户回答或核对后的业务重试使用新的 id。接收回执不表示执行完成。

已配置事件触发 Routine 后，可提交对应事件：

```sh
curl -s http://127.0.0.1:7433/events \
  -H 'content-type: application/json' \
  -d '{"id":"event-1","conversationId":"me","name":"docs.changed","text":"项目需求文档有更新"}'
```

该接口唤醒匹配的 Routine，不自动创建 Work。接口面向本机可信调用，没有认证，不直接暴露公网；远程访问方式见 [部署](../deployment.md)。
