# Web Channel

Web 是 Aide 的浏览器 Channel，提供会话导航、聊天、工作列表与用户交互。与 Lark 的共同边界见 [Channel](README.md)。

## 前后端分工

`src/web/` 放浏览器页面、脚本、样式与 Markdown 渲染。`src/api/` 提供 HTTP 路由、输入校验、响应与 SSE，handler 通过应用提供的接口调用 Core / Personal 能力；Work 生命周期规则由 WorkService 负责。共享的消息和执行展示投影仍在 `src/channel/`，供 Web 与 Lark 使用。

## 消息与 Markdown

用户消息、Aide 正式回复，以及执行过程中的思考与文字输出使用同一 Markdown 渲染器，支持标题、列表、引用、代码块、表格和链接。流式内容按当前完整文本重新解析，历史记录和重连快照使用相同规则。表格与代码块可横向滚动。

浏览器 bundle 内置 markdown-it，关闭原始 HTML 并保留 URL 校验；链接在新页打开，禁用图片语法以避免展示内容主动加载外部资源。工具原始参数与结果保持纯文本。渲染只改变展示，消息和 Ledger 继续保存原文。

## 实时进展与历史

同一 Input 的过程和答案呈现在一个回复块中，遵循 [Channel 的三态展示约定](README.md#回复展示状态)。外层默认展开，内部「过程」和「回答」独立展开详情。进行态的两行过程预览显示最新思考及当前工具，回答预览最多三行并跟随最新输出；结束后过程显示概况，回答预览切换为正文开头。完整态保留 Markdown 和工具记录。

展开选择按 Input 与区域保存在当前页面中；从进行区转入历史区、流式增量和重连都复用同一身份。默认缩略与用户展开分别控制，结束时不会打断正在阅读详情的用户。用户浏览历史时保留页面滚动位置。

收到的 Input 与 Chief 的处理结果分别展示。Channel 与 Source 输入按来源分类显示稳定图标，并标注来源、接收时间与处理状态。环境变化优先展示环境、namespace 和 Workload 名称；Lark 展示私聊、群内 @ 或讨论进展及消息原文。Source 卡片可展开来源资源引用与完整 observation 数据；静默消费后仍保留输入卡片，标记“已查看 · 保持安静”。这些卡片直接投影已关联 Input，不保存为出站 Message。

执行标题旁显示实际 Harness 的图标与名称（Chief、Pi、Codex、Claude Code、DSH）；标识读取 Ledger 的执行事实，刷新与历史重放保持一致。

接收 Input 后显示排队或处理状态，完成后用正式 Message 替换正文增量。问题保留独立的 Core 身份与 pending / answered / cancelled 状态：待答问题默认完整显示在回答区，已回答或已取消的问题归入过程区，不拼入最终答案或预览。模型未提供思考内容时显示真实处理状态。当前覆盖 Chief 接话过程，Work 的后台执行通过事项卡片展示状态。

```text
Pi SDK delta / tool event → Pi Adapter → Core Event → Session Projection
                                                        ↓
Conversation / Input / Message → conversationView → AgentUE UIModel
                                                        ↓
                          PatchEmitter → encodeSse → 浏览器 applyPatch → 网页
```

Pi Adapter 将 `text_delta` / `thinking_delta` 映射到现有 `agent_message_chunk` / `agent_thought_chunk`，消息结束时使用相同 ID 提交完整内容。工具循环的中间发言保持 commentary，只有成功收口的最后答复标为 final。展示进展不改变 Harness 的完成语义，也不触发 Work CRUD。

`src/channel/view.ts` 从已有 Session Projection 选择显式关联当前 Conversation 的 HarnessInvocation 及其 Turn，不发送内部提示词或整个工具原始响应。它生成 `biz: aide.conversation` 的 AgentUE UIModel：`meta.conversation_id` 和 `meta.activity` 表示会话与当前执行状态，正式 `message` 和每个 Turn 对应的 `execution` 按时间排序；同一次 Chief 处理的 execution 与正式回复通过 AgentUE 原生 `group_id` 分组；输入处理按 inputId 关联，定时处理按持久执行身份关联，来源是 Conversation 处理记录和 HarnessInvocation，不靠相邻顺序猜测。`thought` / `text` / `tool` 通过 `parent_id` 归属到该 execution，内部保持 Ledger 时间线顺序。不同类别的 ID 有前缀，避免业务消息与执行事件的身份冲突。

`src/api/stream.ts` 使用 SDK 的 `PatchEmitter` 和 `encodeSse`，通过 `GET /stream?conversationId=...` 输出 AgentUE SSE。首次连接与重连发送 `start` 完整快照，之后新增或更正 block 用 `set`，正文增长用 `append`，执行状态变化用 `meta.activity` 的 `set`。完成只改变 execution 状态，不移除其内容；消息插入导致 block 顺序变化时发送新的 `start` 替换模型。

流式变更合并后发送，空闲连接发送 AgentUE `ping`，独立写入的 Work outbox 定期检查。发送阻塞时等待 drain，基于上次已写出的模型计算最新 patch。连接定期以 `end` 正常结束，由 EventSource 自动重连；投影失败发送 `error` 后 `end`。首次投影失败则直接返回 HTTP 500。断开连接清理订阅和计时器，不取消服务端执行；进程退出或网络中断属于传输中断，客户端从新快照恢复。

使用已发布的 `@compforge/agentue` SDK，版本由 lockfile 固定。服务端与浏览器直接引用同一 SDK，不复制协议实现。`src/web/sdk.ts` 仅导出浏览器所需的 `applyPatch` / `parsePatchEvent`，由现有 Bun 在首次请求时打包并缓存，经同源 `/agentue.js` 提供。浏览器按 SDK reducer 更新展示模型，Aide 负责将 block 渲染到页面并保留展开状态、输入焦点和用户浏览历史时的滚动位置。

Core reducer 负责执行事实，AgentUE reducer 负责展示状态，二者职责独立。每次连接的 seq 属于该次交付，不保存 UI patch 日志或按 Last-Event-ID 重放；执行事件仍由既有 Ledger 持久化。

进度不写入 Channel 出站 Message，与 Lark 的卡片更新分别由各自 Channel 渲染。历史过程直接从既有 Session Ledger 重放形成的投影读取，没有另一份轨迹存储。外层回复块和内部两个区域各自保留同页中的手动展开选择，流式增量、重连及后续消息不会重置用户选择；未手动选择时遵循各区域的默认折叠规则。刷新或重启后仍可展开查看旧轮次，未正常结束的执行标为中断。

`tests/pi-agent.test.ts` 使用真实 Pi SDK 和受控模型 SSE，验证完成前已有思考和正文增量、最终文本不重复。`tests/web-progress.test.ts` 使用真实 Host / Runner / HTTP 和模拟 Harness，下载 HTTP 提供的浏览器 bundle，用其真实 AgentUE reducer 消费 SSE，验证会话隔离、增量更新、重连恢复、断开不取消、最终答复与过程历史同时保留、后续轮次分组、重开 Aide 后的 Ledger 恢复、错误收口，以及进度不进入出站消息。

## 会话导航

浏览器 Tab 标题固定为 `Aide`，会话名称只显示在页面内。

网页左栏通过 `GET /conversations` 汇总各 Session 的 Conversation 与仅有工作记录的会话范围，列表携带所属 sessionId，展示 Conversation 的 name 与最近消息摘要；name 初始取首个 Input 文本，后续输入保留名称。列表和对话标题旁提供 ID 复制入口，页面不铺开展示 ID，按最近输入或消息时间排序。名称取首个 Input 的单行文本（最多 80 字符），摘要取已交付消息，不包含其它 Source 观察正文或 Harness 执行细节。当前 URL 指定的空会话仍可进入；浏览列表不创建会话。

列表每项保留复制 ID 图标，其余操作收在三点菜单中；点击展开，点击外部或按 Escape 关闭，也可使用方向键选择。默认操作按当前状态显示“设置默认／取消默认”，主动回顾显示“开启回顾／取消回顾”，复制和三点按钮位于条目内部右上角；条目底部以小房子表示默认联络处、小闹钟表示主动回顾已开启，悬停显示说明，关闭对应状态后图标消失。默认会话的业务语义见 [Personal](../plugin/personal.md#默认联络处)。打开首页时进入用户设置的默认会话；URL 明确指定的会话优先。没有默认会话时展示会话选择与列表顶部的“新聊天”条目，不注入固定的 `me` 会话。新对话在首次发送消息时才持久化。

点击会话导航到 `/?conversation=...`，消息 SSE 与事项查询使用同一个 conversationId。发送消息读取列表中的 sessionId；尚未创建的会话使用 conversationId 作为新 sessionId。页面导航重新建立该会话的展示快照，刷新和前进后退保留 URL 选择；后台执行不受影响。列表更新失败保留已显示条目并独立提示，不覆盖发送状态。关联问题按 Conversation 展示；未关联会话的宿主 Interaction 保留在本地收件区。

会话三点菜单提供“删除会话”。确认后删除该 Conversation 的聊天记录与定时回顾；删除当前会话后切换到剩余会话，优先进入剩余默认会话，没有其它会话时回到会话选择页。待处理输入、执行或问题尚未结束，或仍有关联事项、安排时，需先处理这些内容。空的占位会话不显示删除入口。

`POST /conversations/delete` 接收 `{ conversationId, uid, revision }`。Personal 校验资源身份、版本与关联状态后，经 ResourceClient 删除会话；会话不存在返回 404，状态变化或仍有待处理内容返回 409。共享 Input 和 Session 执行记录保留；同一入口再次创建会话时使用新的上下文，旧聊天与执行过程不会重新出现在新会话中。

## 工作管理

事项和安排卡片均提供“复制 ID”按钮，复制完整工作 ID 后短暂显示“已复制”；复制失败时展示可手动复制的 ID。

事项和安排卡片都可手动删除，确认后通过会话范围内的 WorkService 执行。删除保留已有消息，并停止后续跟进；已发起的外部操作可能仍会完成。失败时展示原因，工作版本变化时需刷新后重新确认。

`POST /work/delete` 接收 `id`、`conversationId` 和 `revision`，沿用 Work 工具的删除流程。当前会话找不到工作返回 404，版本不匹配返回 409。

## 本地 HTTP 接口

Web 页面与 HTTP 调用共用服务入口。提交消息后先返回持久化回执，Chief 在后台处理：

```sh
curl -s http://127.0.0.1:7433/messages \
  -H 'content-type: application/json' \
  -d '{"id":"msg-1","sessionId":"me","text":"读取当前项目 README，告诉我如何启动"}'

curl -s 'http://127.0.0.1:7433/conversations'
curl -s 'http://127.0.0.1:7433/messages?conversationId=me'
curl -s 'http://127.0.0.1:7433/work?conversationId=me'
```

POST `/messages` 返回 `{ inputId, at }`，标识已持久化的输入。GET `/messages` 只返回 Aide 回复与通知，`after=<message-id>` 使用输出消息的 ID 增量读取；输入和处理状态通过会话 SSE 投影展示。重投同一入站消息使用相同 id；用户回答或核对后的业务重试使用新的 id。接收回执不表示执行完成。

已配置事件触发 Routine 后，可提交对应事件：

```sh
curl -s http://127.0.0.1:7433/events \
  -H 'content-type: application/json' \
  -d '{"id":"event-1","sessionId":"me","conversationId":"me","name":"docs.changed","text":"项目需求文档有更新"}'
```

该接口唤醒匹配的 Routine，不自动创建 Work。接口面向本机可信调用，没有认证，不直接暴露公网；远程访问方式见 [部署](../deployment.md)。

## 主动回顾开关

会话列表的「主动回顾」开关修改对应 Conversation 的 trigger，默认关闭、间隔 3600 秒。同一个 Session 中的不同 Conversation 独立控制。尚未持久保存的空会话没有开关。页面不提供间隔编辑。

`GET /conversations` 返回 `sessionId` 和 `trigger`；`POST /conversations/trigger` 接收 `{ conversationId, enabled }`，校验会话存在后持久化，拒绝额外的间隔字段。关闭不会取消已有输入或委托。调度和判断见 [Personal](../plugin/personal.md#conversation-定时回顾)。

Channel 与输入 Source 分别用 `ChannelDefinition`、`SourceDefinition` 声明身份、名称和图标；Input 保存 `origin` 与 `originId` 引用。SourceDefinition 表达输入来源，不承担框架资源发现 Source 的生命周期。Harness 的图标属于现有 HarnessDefinition。图标为 24 × 24 坐标内的 SVG path 数据，浏览器只设置 path 属性，不执行标记或请求远端图片。`originId` 为必填；来源缺失的输入直接拒绝，不迁移旧数据或猜测来源。图标由共享固定列表按 `channel:<id>`、`source:<id>`、`harness:<id>` 做稳定哈希，列表顺序、长度与哈希算法保持不变；名称用于区分可能的图标碰撞。

Channel 与 Source 都从 Conversation 关联的 Input 生成输入卡片，不创建或反查用户 Message 副本。Source 在提交时生成可读的事实正文，原始证据留在 observation；重要性判断、授权与处理策略属于 Chief。View 只消费事实正文、状态和应用装配的定义目录，不解析各 Source 的业务数据。

接入时通过绑定入口确定 Definition：Channel 的入口补齐来源分类；Source 的入口同时记录产生观察的资源引用 `originRef`。定义分类决定稳定图标，资源实例保存观察范围、水位与错误；目标 sessionId 仅用于路由。Chief 的近期上下文由已处理的 Input 与输出 Message 合并投影，不依赖用户消息副本。

## 人物导航与编辑

主导航提供 Conversations 与 Persons 两个同级页面，切换时保持位置一致，滚动内容时页头仍留在视口顶部。Conversations 保留会话列表、消息和工作；Persons 展示跨会话共享的人物列表，以“我”标记服务对象，可按姓名搜索并进入详情。消息带 sender 时提供人物详情链接。

人物详情默认以只读正文展示当前认识，标题后的编辑图标进入编辑状态。编辑框右下角提供取消与确认：取消恢复原文，确认直接保存当前认识，不提交姓名或身份中尚未保存的修改。称呼与外部身份沿用资料保存操作。编辑提交 uid 和 resourceVersion；并发冲突保留编辑状态和草稿，提示重新加载并合并。外部身份重复或 Me 绑定冲突会拒绝保存，本地单人身份不可移除。

GET /persons 列表，GET /persons?id=... 详情，POST /persons/edit 更新；这些接口调用同一 Personal 人物服务和 ResourceClient。打开页面不创建 Conversation。
