# Web Channel

Web 是 Aide 的浏览器 Channel，提供会话导航、聊天、工作列表与用户交互。与 Lark 的共同边界见 [Channel](README.md)。

## 前后端分工

`src/web/` 按页面组织：`conversations/`、`persons/` 与 `inputs/` 各自放置 HTML、TypeScript 入口和样式；`shared/` 提供共用的 DOM、HTTP、剪贴板、Markdown 与基础样式。`src/api/` 提供 HTTP 路由、输入校验、响应与 SSE，handler 通过应用提供的接口调用 Core / Personal 能力；Work 生命周期规则由 WorkService 负责。共享的消息和执行展示投影仍在 `src/channel/`，供 Web 与 Lark 使用。

Conversations 的 `main.ts` 组合导航、会话 tab、时间线、输入框、工作列表与原生审批模块，并管理轮询和 SSE 生命周期。导航持有自动跟随或手动分页意图及菜单状态；tab 持有选中项和各面板的阅读位置；输入框持有发送状态和重试消息 ID；时间线持有展开选择与渲染缓存。模块通过显式回调请求刷新，不相互读取可变状态。离开页面关闭流和轮询；从浏览器往返缓存恢复时保留交互状态，并重新启动连接。

Persons 的状态留在自己的页面入口，人物选择、资料草稿与认识编辑不依赖 Conversation。页面使用 `src/api/types.ts` 中的展示契约和现有领域类型，跨服务边界的引用均为 type-only import，宿主实现不进入浏览器 bundle。

`src/api/assets.ts` 独立管理固定静态资源路由：`/`、`/people` 与 `/inputs` 提供页面，分别使用 `/app`、`/persons` 与 `/inputs` 前缀的 JavaScript / CSS 资产。每页入口首次请求时由 Bun 打包并缓存；HTML、CSS 和依赖随页面归属组织，不另设浏览器 SDK 汇总入口。资源构建失败进入 HTTP 日志，后续请求可以重新构建。

## 产品图标

`src/web/assets/aide.png` 是共用的 512 × 512 产品图标，用于 Web 页头、中英文 README，也可作为机器人头像素材。`favicon.ico`（32 × 32）用于各页面的浏览器标签和书签，`apple-touch-icon.png`（180 × 180）用于手机主屏幕收藏。尺寸版本均由同一图稿缩放导出，保持图形一致。

HTTP 层按固定路由提供图片并保留二进制字节；页面 CSP 允许同源图片。聊天内容仍由 Markdown 渲染器禁用图片语法。产品图标不替代区分 Channel、Source 与 Harness 的分类图标。

## 来源身份与图标

Channel 与输入 Source 分别用 `ChannelDefinition`、`SourceDefinition` 声明身份、名称和图标；Input 保存 `origin` 与 `originId` 引用。SourceDefinition 表达输入来源，不承担框架资源发现 Source 的生命周期。Harness 的图标属于现有 HarnessDefinition。图标为 24 × 24 坐标内的 SVG path 数据，浏览器只设置 path 属性，不执行标记或请求远端图片。`originId` 为必填；来源缺失的输入直接拒绝，来源由提交入口明确提供。图标由共享固定列表按 `channel:<id>`、`source:<id>`、`harness:<id>` 做稳定哈希，列表顺序、长度与哈希算法保持不变；名称用于区分可能的图标碰撞。

Channel 与 Source 都从 Conversation 关联的 Input 生成输入卡片，不创建或反查用户 Message 副本。Source 在提交时生成可读的事实正文，原始证据留在 observation；重要性判断、授权与处理策略属于 Chief。View 只消费事实正文、状态和应用装配的定义目录，不解析各 Source 的业务数据。

接入时通过绑定入口确定 Definition：Channel 的入口补齐来源分类；Source 的入口同时记录产生观察的资源引用 `originRef`。定义分类决定稳定图标，资源实例保存观察范围、水位与错误；目标 sessionId 仅用于路由。Chief 的连续推理由原生上下文承接，业务概览由 Conversation summary / recent 保存。

## 消息与 Markdown

用户消息、Aide 正式回复，以及执行过程中的思考与文字输出使用同一 Markdown 渲染器，支持标题、列表、引用、代码块、表格和链接。流式内容按当前完整文本重新解析，历史记录和重连快照使用相同规则。表格与代码块可横向滚动。

浏览器 bundle 内置 markdown-it，关闭原始 HTML 并保留 URL 校验；链接在新页打开，禁用图片语法以避免展示内容主动加载外部资源。工具原始参数与结果保持纯文本。渲染只改变展示，业务消息保存原文，执行内容由实时投影展示。

## 实时进展与历史

Input、Output 与执行进展分别投影。输入卡片显示来源图标、接收时间、原文和处理状态，详情使用 InputPrinter；静默研判仍保留输入和回执。正式回复来自 Output，模型增量只属于执行过程。

过程与回答的折叠遵循 [Channel 展示约定](README.md#回复展示状态)。用户展开选择、输入焦点和浏览历史的位置由页面维护，增量更新与执行结束不覆盖手动选择。原生权限 Approval 在独立区域处理；say 问题以普通 Output 展示，回答形成新 Input。

```text
Harness 事件 → HarnessActivity 有界实时投影 ─┐
Input / Output / Conversation ────────────┤
                                         ↓
conversationView → AgentUE UIModel → SSE → 浏览器 reducer 与渲染
```

src/channel/view.ts 按明确的 Conversation UID 与 execution / invocation 关联选取进展，生成 biz=aide.conversation 的 AgentUE UIModel。输入卡片直接来自 Input，message 展示块来自 Output，execution 下有 thought / text / tool 子块。group_id 关联同一执行与正式回复，不按相邻位置猜测归属。内部提示词和完整工具原始响应不直接发给浏览器。

src/api/stream.ts 使用 SDK 的 PatchEmitter / encodeSse。首次和重连发送 start 快照，内容更新使用 set / append，会话运行状态和摘要、近期记录分别更新 meta.activity / meta.context。顺序变化时用新快照替换。客户端通过同一 SDK 的 applyPatch 更新模型，Aide 负责页面渲染。

空闲连接发送 ping，连接定期 end 后由 EventSource 重连；投影错误以 error / end 收口，首次失败返回 HTTP 500。背压时等待 drain，再根据最新模型生成 patch。断开清理订阅与定时器，不取消服务端执行；seq 属于当前连接，不通过 Last-Event-ID 回放历史补丁。

当前进程保留活跃和有限近期执行细节，浏览器刷新从快照恢复；Aide 重启后只恢复持久业务 Input、Output 和处理记录，实时执行细节清空。原生历史由 Harness 管理，网页不维护第二份轨迹存储。

tests/web-progress.test.ts 用真实 Host / Runner / HTTP、浏览器 reducer 和模拟 Harness 验证 SSE、隔离、重连、结束、会话上下文与重启边界；tests/pi-agent.test.ts 另用真实 Pi SDK 和模拟模型验证增量事件。这些测试不代表真实模型或平台验收。

## 会话导航

浏览器 Tab 标题固定为 `Aide`，会话名称只显示在页面内。

左侧列表在 Web 侧分页，每页显示 10 个普通会话，默认会话独立置顶并保留在每一页。普通会话沿用最近活动排序。未指定页码时持续跟随当前会话所在页，包括新聊天首次保存后排序变化；自动定位不向 URL 写入固定页码。用户主动翻页或点击会话链接时携带页码，打开链接、刷新和前进后退保留所选页；删除导致页数减少时回到有效的最后一页。每个条目展示关联的事项（Task）数和安排（Routine）数，包含已完成但尚未删除的工作，与会话内事项、安排 tab 的统计范围一致。

网页左栏通过 `GET /conversations` 列出 Personal 的 Conversation，列表携带所属 sessionId，展示 Conversation 的 name 与最近消息摘要；name 初始取首个 Input 文本，后续输入保留名称。列表和对话标题旁提供 ID 复制入口，页面不铺开展示 ID，按最近输入或消息时间排序。名称取首个 Input 的单行文本（最多 80 字符），摘要取已交付消息，不包含其它 Source 观察正文或 Harness 执行细节。当前 URL 指定的空会话仍可进入；浏览列表不创建会话。

列表每项保留复制 ID 图标，其余操作收在三点菜单中；点击展开，点击外部或按 Escape 关闭，也可使用方向键选择。默认操作按当前状态显示“设置默认／取消默认”，主动回顾显示“开启回顾／取消回顾”，复制和三点按钮位于条目内部右上角；条目底部以小房子表示默认联络处、小闹钟表示主动回顾已开启，悬停显示说明，关闭对应状态后图标消失。默认会话的业务语义见 [Personal](../personal/conversation.md#默认联络处)。打开首页时进入用户设置的默认会话；URL 明确指定的会话优先。没有默认会话时展示会话选择与列表顶部的“新聊天”条目，不注入固定的 `me` 会话。新对话在首次发送消息时才持久化。

点击会话导航到 `/?conversation=...`，消息 SSE 与事项查询使用同一个 conversationId。发送消息读取列表中的 sessionId；尚未创建的会话使用 conversationId 作为新 sessionId。页面导航重新建立该会话的展示快照，刷新和前进后退保留 URL 选择；后台执行不受影响。列表更新失败保留已显示条目并独立提示，不覆盖发送状态。业务问题作为 Output 显示在会话中，回复形成新 Input。原生工具权限与 Hook 信任在独立 Approval 区域处理。

会话三点菜单提供“删除会话”。确认后删除该 Conversation 的聊天记录与定时回顾；删除当前会话后切换到剩余会话，优先进入剩余默认会话，没有其它会话时回到会话选择页。待处理输入、执行或问题尚未结束，或仍有关联事项、安排时，需先处理这些内容。空的占位会话不显示删除入口。

`POST /conversations/delete` 接收 `{ conversationId, uid, revision }`。Personal 校验资源身份、版本与关联状态后，经 ResourceClient 删除会话；会话不存在返回 404，状态变化或仍有待处理内容返回 409。共享 Input 与独立 Output 按各自生命周期保留；同一入口再次创建会话时使用新的上下文，旧聊天与执行过程不会重新出现在新会话中。

## 工作管理

选中会话后，中间区域提供“对话、摘要、近期记录、事项、安排”五个 tab，默认显示对话，不再使用右侧栏。输入框仅在对话中展示；原生权限 Approval 和更新失败提示位于 tab 内容之外，在任何 tab 都可处理。事项与安排 tab 展示总数，需要用户回答或核对结果时显示提示圆点；卡片保留具体状态。

同一会话切换 tab 保留输入草稿、展开选择与各面板滚动位置，不重连 SSE、不停止后台执行。隐藏对话继续接收最新快照，回到对话后再渲染，避免隐藏布局影响自动跟随判断。tab 支持左右方向键与 Home / End 切换，窄屏可横向滚动。切换到另一个会话时回到对话 tab，并清空旧会话内容。

对话区保留最小可用高度。横屏手机或矮窗口放不下审批与输入框时，会话详情允许整体滚动，审批区保留自身滚动；手动放大输入框后，对话区也允许滚动到发送按钮，避免裁切操作入口。

摘要与记录读取 Conversation 的 summary / recent，并随 SSE 更新；近期记录按最新在前展示时间与正文。每个 tab 使用完整内容区滚动，空摘要和空记录分别显示占位提示。

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

会话列表的「主动回顾」开关修改对应 Conversation 的 trigger，默认关闭、间隔 3600 秒。各 Conversation 独立控制。尚未持久保存的空会话没有开关。页面不提供间隔编辑。

`GET /conversations` 返回 `sessionId` 和 `trigger`；`POST /conversations/trigger` 接收 `{ conversationId, enabled }`，校验会话存在后持久化，拒绝额外的间隔字段。关闭不会取消已有输入或委托。调度和判断见 [Personal](../personal/conversation.md#conversation-定时回顾)。

## 人物导航与编辑

主导航提供 Conversations、Persons 和 Inputs 三个同级页面，切换时保持位置一致，滚动内容时页头仍留在视口顶部。Conversations 保留会话列表、消息和工作；Persons 展示跨会话共享的人物列表，以“我”标记服务对象，可按姓名搜索并进入详情。消息带 sender 时提供人物详情链接，Input 卡片提供处理 Timeline 链接。

Inputs 提供全局输入目录，支持按 Connector、来源类型、具体观察源、处理状态、异常记录和正文或 ID 组合筛选。筛选区位于主导航下方，横跨列表与详情；宽屏横向排列，窄屏自动换行，列表和详情在其下方展示。服务端先筛选再分页，默认每页 20 条，按接收时间倒序并以资源键稳定排序；列表不读取完整来源证据，也不刷新输入的容量访问时间。筛选和选中项保存在 URL 中，页面轮询刷新已保留的处理事实。

详情展示原文、来源证据，以及接收、路由、各 Conversation 研判、各 Work 请求应用与办理回执；显式关联的 Output 独立展示创建与投递。已删除或被同名新资源替换的消费者仍保留旧处理记录，链接只指向 UID 匹配的当前实例。时间线依据和重试历史的范围见 [Input](../personal/input.md#web-检索与处理-timeline)。

人物详情默认以只读正文展示当前认识，标题后的编辑图标进入编辑状态。编辑框右下角提供取消与确认：取消恢复原文，确认直接保存当前认识，不提交姓名或身份中尚未保存的修改。称呼与外部身份沿用资料保存操作。编辑提交 uid 和 resourceVersion；并发冲突保留编辑状态和草稿，提示重新加载并合并。外部身份重复或 Me 绑定冲突会拒绝保存，本地单人身份不可移除。

GET /persons 列表，GET /persons?id=... 详情，POST /persons/edit 更新；这些接口调用同一 Personal 人物服务和 ResourceClient。打开页面不创建 Conversation。
