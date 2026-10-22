# Personal 业务模型

Personal 是 Aide 的内置个人助手插件：Chief 接收输入并判断是否需要持续跟进，Task 负责有限目标，Routine 负责持续职责。用户可以自然聊天，外部系统也可以带来观察；只有值得承担和推进的工作才进入 Task / Routine。

## Person 与输入关系

Chief 持续理解人，并围绕人的目标推进事。Person 是人物 CRD，包含“我”和其他人；Work 是需要持续推进的 Task / Routine。

Person 保存姓名、外部身份和 profile。身份由 provider / scope / id 唯一确定，姓名只用于展示；同一人可绑定多个账号，跨应用的裸 ID 不作比较。外部资料同步只补全尚未识别的名字，不覆盖用户资料或认知。

Person 是人物身份与认知的基础，Me 是附加的可选身份标记：它告诉 Aide，已经识别的人物中哪一个是“我”。Connector 与 Channel 带来的可识别人类身份都按 Person 组织；未配置该入口的 Me 时，仍正常接收和处理 Input、识别人并积累人物认知。配置 Me 后，Aide 才能将该入口中的身份认作本人，并结合其他已绑定身份形成跨入口的本人认知。

访问授权与本人标记分别声明：Connector 的执行身份决定能访问哪些数据，Me 通过匹配 Person 的外部身份确定 Personal.me。以 Lark 为例，外层 appId / userId 校验 CLI 使用的应用与已授权用户，实际凭证由 CLI 管理；me 中的 appId / openId 标记该应用下哪个人是本人，不授予访问权限。执行账号可能属于另一个人，不能从登录凭证推导本人。本地单人 Web 有固定身份 web / local / me。配置标记在启动时绑定到同一个 Person，冲突会报错。

Person 目录属于 Personal 插件实例，由各 Conversation 共享。资源与引用不携带 sessionId，目录不启动 Harness 或 Reconcile。人物资源受容量保护，ResourceClient 写入在同一存储事务内做版本、Schema、身份唯一性与 Me 约束校验，包括批量 commit。

Channel、Source 和按需 Connector 消息读取持续贡献人物事实。发送者及上下文中的作者拥有可识别用户身份时解析为 Person；缺少主体类型的提及 ID 保留为证据，避免把机器人建成人物；系统事件不需要人物。Input.sender 是可选的 Person 引用，多作者讨论没有单一发送者时留空，逐条作者保留在 observation 中。Output.receivers 同样引用 Person，可以为空或包含多人；Input.source 与 Output.target 使用 Address。Aide 结合输入性质、已有委托与处理进展，决定是否沟通、对谁表达、送到哪里；这些决定不要求与单条 Input 一一对应。

Input.relation 描述输入相对于 Me 的关系：

| 值 | 含义 |
|---|---|
| sent | 我发出；仍需识别引用与代发内容 |
| received | 明确发给我，如 @、回复本人，或执行账号确属本人时的私信 |
| observed | 来自本人的观察范围，不证明实际已读 |
| 缺省 | 身份或关系依据不足 |

Web 输入为 sent。别人私信机器人或仅 @ 机器人不能据此认定为我收到；Lark Source 对各条消息分别分类，混合讨论仅在本人的观察范围内归为 observed。环境与需求监控属于配置的观察范围。关系随 Input 持久保存，不因后续身份编辑而改写历史。

profile 保存理解本身与必要背景、日期，区分明确表达和推断，不引用 Input ID。Chief 的 profile_person 工具更新 understanding；用户在 Web Persons 编辑资料、身份与当前认识。明确修正独立保存，Chief 无法通过工具修改该字段；推断不得覆盖修正。并发更新必须重读后合并，不能盲目覆盖。

人物工具沿用 Work 的接入方式：模型工具调用 Personal 服务，再经 ResourceClient 更新 CRD，无需新增 Core verb 或人物输入队列。读取、补充、合并、纠错在正常 Chief 轮次内发生，Conversation 摘要仍只维护话题窗口。详见 [Chief](../harness/chief.md#人物认知)。

## 主动性与上下文

Aide 的主动性围绕一个动作展开：把发生的事放入合适的上下文（place it in context），结合那里已有的关注、委托、历史和进展，决定推进、更新、沟通、等待或忽略。归位让一次新变化接上此前的工作。

| 上下文 | 承载什么 | Reconcile 的职责 |
| --- | --- | --- |
| Conversation | 一个话题的交流、近期关注与相关委托 | 理解新输入或定时回顾，直接处理简单事情，将持续工作交给 Work |
| Task | 有限目标、完成条件、相关事实、执行历史与当前阻塞 | 持续推进目标直至完成 |
| Routine | 持续职责、历史基线与当前轮次的目标和进展 | 推进当前轮次直至完成，再等待下一轮触发 |

归位可以涉及零个、一个或多个上下文，也可以止于 Conversation。Input 保留原始事实与来源；关联上下文时，保存引用或将相关事实、用户决定承接到对应资源。需要持续跟进时优先关联已有 Work，再按需要创建 Task / Routine。目标与进展由这些资源持有，Harness 的会话和记忆帮助理解它们。

例如 executor 的 Pod 发生变化，Chief 先找到关注该服务的话题。若话题下已有“跟进 OOM 修复”的 Task，就将变化作为新证据交给它继续核实；若属于稳定性巡检，则进入 Routine 当前轮次的观察；只有近期关注时，Chief 可以核实后直接提醒。没有改变判断的新信息可以静默处理。

## 持续委托

Personal 围绕用户交付的目标持续负责。普通交流可以直接结束；需要保留目标、等待变化并继续推进的事情进入 Work。创建工作前先检查已有委托，将补充信息、用户决定与外部变化关联到同一件事，避免每次触发都重新建任务。

Task 与 Routine 按目标的结束条件区分。Task 达到完成条件后结束，即使它持续一周、经历多次执行或等待，仍然是一个 Task。Routine 承担持续职责，每轮执行结束后继续等待下一次条件满足；频率只是触发方式。例如“跟进这个 PR 直到合入”是 Task，“持续关注我的 PR，有新阻塞就处理或通知”是 Routine。

一项委托的连续性包括目标、进展、已经发生的动作、等待条件和结果依据。执行、等待用户、等待外部变化及恢复都属于同一项工作；每次推进都从最新事实开始。外部动作结果不确定时先核对，避免把已经生效的操作重新执行。停止定时回顾、暂停工作和撤销外部动作分别作用于触发、业务调度和外部系统。

Source 和 trigger 提供重新判断的机会。已有委托决定可以继续承担的工作；相关的新机会可以向用户提出，用户的兴趣与历史偏好用于理解背景。Chief 的主动判断与沟通原则见 [Chief](../harness/chief.md#主动判断与沟通)。

## 主流程

![Personal 主流程：Input、Conversation 与 Work 的 Reconcile 及 Verb 调用](../assets/personal-flow.svg)

Chief 可以直接处理、回复或保持安静；需要独立跟进的事情，再交给 Task / Routine。

Chief 是业务角色。Conversation Controller 调度批次，Batch Controller 执行固定上下文中的工作；Chief Harness 执行 `agents/chief/` 中的 Agent，使用通用 Pi 能力以及 Personal 工具。Task / Routine 按根级 `defaultHarness` 选择执行实现，缺省为通用 Pi。Chief 的提示词、上下文和记忆优化方向见 [Chief Harness](../harness/chief.md)，插件机制见 [Plugin](README.md)。

## 输入与上下文

Input、Output、Route 与 Conversation 都是 Personal 的普通资源。Channel / Source 提交持久 Input，单例 `Route/global` 决定把它归入哪些 Conversation。底座按资源 UID 组织执行上下文，不需要为 Route 创建内部 Session。

Route 默认 Controller 监听 Input 与自身的变化。每次协调补扫未完成路由的 Input，幂等纳入 `status.pendingInputIds`，因此提交成功但事件丢失、或进程在入队前退出，都能在重启后恢复。规则匹配已有话题 `sessionId`，或沿 `originalInputId` 的投递凭据找到已有 Conversation；命中后立即追加，不再给 Default 额外复制一份。Channel 的明确话题可以建立 Conversation；Source 的陌生话题线索本身不触发创建。

未命中规则的输入按数量或最早等待期限组批；立即输入无需等满一批。Route 保存固定的 Input、所有现有 Conversation 的身份与有界摘要，再由具名 `batch` Controller 调用专用 Route Agent。两个 Controller 的队列独立，模型等待不妨碍新输入的规则分发。Route Agent 使用 Pi 执行协议，但拥有独立身份、提示词与可选模型配置，不加载执行工具、Work/Person 工具、记忆扩展或技能，也不负责回复。

模型为每条 Input 返回零个或多个已有 Conversation UID。宿主检查输入覆盖完整、无重复、目标属于候选快照；空目标使用用户选择的 Default。没有 Default 时建立无通信地址的默认会话；没有任何 Conversation 时直接使用该兜底，不调用模型。Source 的位置只说明事情在哪里发生，不自动成为回复地址。

完整分发计划先持久化，再逐项调用 `appendConversationInput`。投递按 Input ID 与 Conversation UID 幂等，允许一个 Input 进入多个 Conv；全部投递完成才从 Route 队列移除，并清空该批快照。并发新到输入保留在队列中，不随旧批完成而丢失。进程退出后，已落盘计划继续投递；未落盘的纯分类可重试，不能因此重放 Chief 已经执行的业务动作。候选会话删除后不会投递到同名替代实例，失败保留计划与引用并记录错误。

讨论续报等待原始 Input 路由完成后再沿其凭据关联。旧版本已经完成的 Input 不重新路由；未完成的固定创建记录继续按原身份恢复。Input 路由状态保存计划与凭据，Route 的队列与当前批次保护尚未完成的事实免于回收。

Conversation.address 只在由 Channel Input 创建时取首个 Input.source，后续追加不覆盖。Immediate 输入的直接回复使用该 Input.source；其它通知明确选择 target 或使用 Conversation.address。多个 immediate 地址不同时，say 必须指定 respondToInputId 或 target。路由去向、通信位置和执行授权分别判断。

Conversation 的 spec 保存身份、可选 address 与触发策略；status 保存 `pendingInputIds`、下次触发时间和一个 `batch`。Batch 是 Conversation 内部的处理单元，定义在 `conversation/batch.ts`，没有独立 CRD。没有第二份 recentInputIds 或持续增长的 processing 表。

两个 Controller 观察同一个 Conversation：默认 Controller 执行 `reconcileConversation`，具名 `batch` Controller 执行 `reconcileBatch`。它们拥有独立队列，通过明确的 status Watch 协作，避免等待 Harness 时挡住新输入调度。

- Conversation 按立即输入、数量阈值、最早输入等待期限或 trigger 到期组批。空批次可以执行定时回顾。先持久化 Batch 的 inputIds 和 context，再交给执行 Controller。
- Batch 固定 prompt、继承历史和本批输入，绑定 executionId 后调用 Harness。运行中到来的普通 Input 继续排队，不修改该快照。
- Harness 通过 say 保存独立 Output，Channel 负责投递。需要补充信息时说明问题、结束本批；后续答复作为普通 Input 由新 Batch 处理。
- Batch 的最终文本是内部总结。普通用户请求必须通过工具沟通，Source 与定时回顾可以保持安静。一次执行的总期限为两天。
- Batch 完成后，Conversation 幂等确认消费，只从 pendingInputIds 移除该批成员。完成的 Batch 保留，下一次组批继承其结果上下文后原子替换，不串联历史 Batch。

立即 Input 到来时，Conversation 请求中断正在执行的 Batch；Host 取消 HarnessInvocation，并等待正在运行的 Turn 实际停止。新 Batch 优先处理立即 Input，同时承接旧批成员及不确定结果，明确要求核对已发生的动作，不能盲目重放。纯上下文压缩先完成交接，再处理新请求。用户答复也走这一普通输入路径。

每批使用 Conversation 资源对应的执行上下文，并建立新的原生 Harness 上下文。`freshContext` 同时保存 Ledger 历史边界，阻止 catch-up 重新注入已遗忘内容。下一批的近期材料和 summary 都来自上一批有界的结果上下文，长期 Memory 仍由 Chief 的上游扩展管理。

上下文交接包含完整 Input 原文、内部总结和已发送消息；超出预算时，Batch 用关闭业务工具和记忆扩展的 Harness 分段压缩。每段成功后持久化 offset 与摘要，整份交接完成后才标记 done。失败保留原文引用和检查点，新的立即请求可恢复纯压缩阶段，不重新执行业务动作。进程中断时，queued Batch 可以启动、compacting Batch 可以从检查点恢复；running Batch 标记 interrupted，当前运行时不恢复 JavaScript 调用栈或重放工具动作。

幂等接收凭据保存在 Input 上，随 Input 生命周期清理，不依赖 pending 队列是否仍含该 ID。队列和当前 Batch 的引用保护 Input；批次替换后不再引用的 Input 由 Host 按资源容量策略回收。Web 从现存 Input 和接收凭据展示原始事实，从 Ledger 展示执行轨迹；不把批次状态或版本覆盖进 Input 资源。Output 独立受 Host 按 kind 的容量策略管理，未送达或仍被 Batch 引用的输出受保护；Conversation 不再维护第二份消息正文或固定条数的副本。

Input 路由完成、批次消费完成、工作目标完成与消息送达分别记录。错误不会对后续每条观察各发一条通知；失败 Batch 保留 pending 引用，后台执行暂停，用户可以用新请求核对并接手。

编程领域使用 Repository = forge + path、Requirement = source + category + id、PR/MR = forge + path + number。Chief 在工作指令中保留实体身份与工作目录，不根据仓库名字猜测本地 checkout。

## 默认联络处

Conversation 的 `spec.default` 标记用户选择的默认联络处，缺省为 false。整个 Aide 实例最多有一个默认会话。用户通过 Web 设置或取消；切换通过资源事务清除旧标记并设置新标记，存储校验保证最多一个默认。删除或取消默认后，下一次需要兜底时 Route 会建立默认会话。

默认会话使用普通 Conversation 的上下文、Work 和 Chief Reconcile，承接没有合适话题的输入。已有明确目标的输入直接交给对应话题；是否值得回复、提醒、询问或推进工作，由承接的会话判断。需要用户处理的 Aide 服务问题也须先作为 Input 提交，不直接广播错误日志。

默认标记不打开 trigger、不授予额外执行权限，也不合并其它会话的上下文。个人私聊适合作为默认联络处，工作群继续承载各自话题。

## Conversation 定时回顾

Conversation 与 Routine 的 `trigger` 都是调度机制，只决定何时唤醒 Reconcile；业务判断由各自 Reconcile 负责。Conversation 的定时触发用于持续照看话题。每个 Conversation 独立控制开关与间隔，默认关闭、间隔一小时；Web 提供开关。收到新 Input 和 trigger 到期都会唤醒同一个 Conversation Reconcile，定时唤醒已有明确上下文，不生成外部 Input。

Personal 决定回顾策略，Core 提供通用定时唤醒与恢复能力。Runner 根据 Reconcile 返回的重新入队时间调度，下一次回顾时间与每次处理记录保存在 Conversation 中，重启后恢复，停机错过的周期合并处理；普通消息不会不断推迟到期回顾。回顾与输入处理按会话协调，避免堆积重复工作。关闭 trigger 停止后续定时回顾，已有 Input、Work 与 Source 继续遵循各自生命周期。

Conv 的回顾关注话题中的遗漏、进展、阻塞和可采取的下一步，Routine 的定时触发则承担明确的本轮职责。回顾可以静默结束；需要执行时依据已有委托，需要补充信息或用户决定时再询问。记忆中的意向不自动成为执行委托，也不重复提出没有新依据或用户回应的建议。

Chief 可以推进已有委托、用 say 提出建议或问题，或静默结束。`say` 保存独立 Output，由 Channel 独立投递；用户回复 say 是新的 Channel Input。定时回顾仅在有实际消息或问题时通知用户，静默回顾的内部总结不渲染为回复。

## 环境观察

Personal 的 EnvironmentSource 经 Connector Verb 周期采样 Workload；首次静默建立基线，后续将变化合并为 `workload.changed` Input，由 Chief 分配到相关 Conversation，再结合话题与 Work 判断。它与需求 Source 共用输入归位流程。范围、配置、比较与恢复规则见 [Environment 变化](../connector/README.md#environment-变化)。

## 决策与问答

Chief 拥有原生文件/CLI 工具、五个 Work 工具，以及 `read_requirement`、`list_pull_requests`、`read_pull_request`、`read_pull_request_comments`、`list_connectors`。

Chief 只通过 say 沟通。问题也是普通 Output，不创建挂起的 Interaction，不等待同一次 Harness 执行恢复；用户回答是新的 Channel Input。Input 不含 replyTo，也不会把下一条消息自动匹配为某个待答问题。Chief 根据新批次的输入与上下文判断其含义。

Web 与 Lark 使用相同的交流流程；群里用户后续回复仍需 @Aide。Hooks 信任和 Harness 工具权限通过网页独立的 Approval 区域处理，普通聊天不会授予这些权限。

Source 观察没有用户指令的地位。Chief 应读取详情、查询已有 Work；在已有委托内可以推进工作，缺少目标或授权时询问。不值得打扰的观察可调用 `dismiss_observation`，保存原因但不向 Channel 发消息。

普通回复由 Chief 的工具调用 `say` 创建独立 Output，Batch 保留本批 Output ID 至上下文交接完成；界面按 Conversation UID 查询历史输出。Input 与 Output 的关联可选且多对多。POST `/messages` 返回入站持久回执，业务结果异步出现；没有每次固定发出的“已创建事项”回复。模型进度不会重复投递为最终回复。

Chief 可能调用有副作用的工具，因此运行中断、失败或重启均不自动重放。状态和失败提示保留，用户核对后用新消息重新交办。同一输入 id 的传输重投永远不作为业务重试。调用栈不跨重启恢复，Conversation 中运行的 Batch 标记 interrupted；Work 的结果处理见下文。

## 分配与追加输入

Batch 中的 Chief 可以直接处理、创建或删除工作，也可以用 `append_input` 把原始 Input 交给已有 Task / Routine。创建确立新的目标，删除结束资源生命周期；对已有工作的补充通过输入承接。Chief 不直接修改已有 Work 的执行状态、下次调度时间和执行历史。

共享事实与拆分工作有不同语义：多个 Work 可以引用同一原始 Input，独立消费；当一件大事需要拆分时，派生输入各自说明交付范围，并关联原始 Input。Chief 的交接说明与原始事实分别保留。直接处理、追加和创建可以组合使用，一份 Input 不要求只对应一份 Work。

`append_input` 成功表示投递已持久保存。原始输入通过 `inputId` 关联并保留来源；新请求或交接说明使用 `text`。默认追加上下文；修改定义、暂停、恢复与回答问题使用明确请求，由目标 Work Reconcile 应用。外部观察只作为事实，不能冒充用户控制请求。原始输入按目标与请求去重，Chief 新请求按工具调用身份去重。

Work 的输入队列属于 spec，消费进度与执行状态属于 status。Reconcile 将输入承接到历史并原子提交消费进度与处理结果；运行中新到的输入留待后续处理。暂停、已完成或结果待核对的工作仍可记录新事实，执行恢复需要明确请求。非法请求保留原因与消费记录，不阻塞后续输入。

## Task / Routine 与 Work

Work 接住与自身目标相关的新事实、用户补充和决定，保留来源及有助于下一步判断的历史。每次 Reconcile 结合目标、已有进展和新事实，决定哪些动作现在可以执行、哪些需要等待、提醒或询问用户。Task 的收敛目标是整个有限目标完成；Routine 的收敛目标是当前轮次完成，一轮可以跨越多次执行和等待。Harness 返回或一次 Reconcile 结束，只表示本次处理结束，完成状态还需满足对应的业务条件。

Task 与 Routine 各自的 Controller 观察 ready 或已到期的 scheduled，先保存 running，再请求 Harness 执行。正常结果、问题和状态一起提交；跨越执行等待后按 uid 重读资源，保留用户最新指令与暂停状态。版本冲突只重试提交，不重复执行外部工作。

执行返回 ask 时，工作保存为 waiting 并结束本次调用，用户回答后再唤醒；返回 wait 时保存动态唤醒时间。Routine 完成本轮后继续等待下一次触发，Task 完成后结束。事件触发更新匹配的 Routine，由其 Controller 推进。

`task/` 与 `routine/` 各自保存 CRD 定义（`model.ts`）和 Reconcile（`reconcile.ts`）：Task 完成后进入 done，Routine 完成本轮后回到 scheduled，并按自己的触发规则计算下次时间。两者共享 personal 内部的 Harness 调用、结果校验、并发更新处理和 Output 原子提交；这些辅助操作位于 `execution.ts`，不进入通用 Host / Runner。

资源类型决定身份；Task 没有周期触发配置，Routine 必须有 cron 或事件触发。Work 工具与网页聚合这两类资源，对外仍返回 task / routine 分类。Chief 的会话处理观察 Personal 定义的 Conversation 资源。

改变工作类型由 Chief 组合现有工具：读取原工作的目标与结果，创建目标类型的新工作，再按用户意图暂停或删除原工作。新工作使用独立 id 和资源执行上下文，相关上下文写入指令；保留原工作可查看完整历史，删除则将输入回执保留到 Conversation，独立 Output 继续投递和展示。各步分别持久化，不承诺跨资源的原子转换；中断后应查询现状再继续。暂停和删除都不取消已经运行的外部动作。

## 完成依据与交付

Task 的目标应包含可判断的完成条件；Routine 应说明每轮检查什么、哪些变化需要处理或通知。执行者返回的结论需要结合工具结果、产物和外部状态解释，例如 PR 是否已合入、测试是否通过、文件是否包含预期内容。结果格式校验保证返回值可处理，业务完成条件决定目标是否达成。

Personal 的 Controller 负责解释执行结果并推进工作状态，Core 保存执行事实。领域专用验收由对应 Controller 通过 Core Verb 查询外部系统或请求验证，开放问题则由 Harness 调查并提供依据。无法确认的部分保留为待核对或等待，向用户说明缺口。

工作完成和消息送达分别记录。通知失败只影响交付，不能让已完成的业务动作重新执行；交付应说明结果、依据以及仍需用户决定的事项。

## Work 工具与执行结果

| 工具 | 行为 |
| --- | --- |
| `list_work` | 列出绑定会话的 Task / Routine |
| `read_work` | 读取目标、状态、历史、revision 和待回答问题 |
| `create_work` | 创建工作并唤醒对应 Reconcile |
| `append_input` | 追加原始输入、交接说明或控制请求，由 Work Reconcile 消费 |
| `delete_work` | 请求删除，停止后续调度并保留已交付消息 |

WorkService 绑定宿主确定的 conversationId，模型不能传入其它会话范围。读操作不唤醒执行，输入追加通知对应 Reconcile，删除需要最近读取的 revision。输入追加不直接改变业务状态。删除前归档消息和输入回执，已运行回调不能重建被删资源。

Task / Routine 校验 Harness 的 finalText。执行失败或中断标为 uncertain，执行已结束但结果无法解析或校验则标为 invalid_result；两者均等待用户核对后明确继续，不自动重放。业务等待用户则保存为 waiting，收到回答后由 Reconcile 继续，能够跨服务重启恢复。

Chief 问题作为 Output 持久保存，用户可在重启后发送新 Input 继续；没有需要恢复的业务问答调用栈。Task / Routine 的 waiting 保留领域阻塞状态，由 Chief 根据新输入决定是否 append_input。上下文结合近期消息、工作记录及连接器查询，工作状态以 Task / Routine 为准。

### 中断与有界消费

pendingInputIds 不设数量上限。batchSize、最早等待期限和 immediate 决定组批时机；Host 按 ResourceDefinition 的引用与释放规则管理总容量。消费前先保存 Input 的接收凭据，重投不会将已消费输入重新排队。
直接请求的中断通知与轮次失败状态原子保存，恢复进程不会重发同一轮的通知；Source 和定时轮次保持静默。
历史记录超过单次摘要预算时，Conversation 保存分段偏移与中间摘要，每次摘要调用只处理有界片段。
原始 Input 引用保留到整条记录已被摘要覆盖；失败后保留进度，恢复时从已提交偏移继续。

## 验证

`tests/chief.test.ts` 验证真实 Runner 的接收、隔离和失败不重放；Harness 与平台使用替身。`tests/pi-agent.test.ts` 另覆盖真实 Pi SDK 与 Chief 工具。`tests/conversation-intake.test.ts` 覆盖统一接收、超过旧上限、重投去重，以及 say 提问后跨重启用新 Input 继续。`tests/harness-approval.test.ts` 验证原生权限拒绝、校验和取消。真实环境验收见 [E2E](../e2e.md)。
