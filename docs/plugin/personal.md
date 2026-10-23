# Personal 业务模型

Personal 是 Aide 的内置个人助手插件：Chief 接收输入并判断是否需要持续跟进，Task 负责有限目标，Routine 负责持续职责。用户可以自然聊天，外部系统也可以带来观察；只有值得承担和推进的工作才进入 Task / Routine。

## 从大量输入到有价值的输出

从信息处理的角度看，Aide 的一个目标，是把每天成百上千条 Input，转化为数量可控、注意力负担可接受且有价值的 Output：在合适的时机，向合适的人和地址，给出值得关注的答复、提醒、问题或进展。判断价值要结合用户的目标、已有委托与当前处境，让用户把注意力放在需要了解和决定的事情上。

这个过程包含归属判断、关联上下文、核实事实、研判影响、推进工作和选择沟通时机。有些 Input 只更新认识、记忆或已有工作的进展；多条 Input 可以汇聚成一条 Output，一条 Input 也可能在持续跟进中促成多次 Output。静默处理同样可以有明确的判断和结果。

Input 同时承载收到的事实和围绕这份事实的处理进展。原始内容保持不变，各组件将自己负责环节的处理时间、去向、结论及异常写入 Input.status。沿着一条 Input，可以知道它被分派到哪些 Conversation、哪些 Chief 已经研判、哪些 Task / Routine 正在办理，以及还有什么尚未完成。这为协作、恢复与问题排查提供共同依据。

可以借用 Kubernetes Pod 的直觉理解这种协作：多个组件围绕同一个持久对象工作，各自在 status 中留下负责环节的痕迹。Aide 中，route、assess、handle 分别表达路由、研判和办理。Input 保存这些环节的状态与结果摘要；详细执行轨迹、工作目标与进展、输出正文分别由执行记录、Work 和 Output 承载，并遵循各自的保留策略。

这是理解 Aide 信息处理过程的一个视角。Aide 的完整职责还包括理解人、承接目标、持续行动以及在变化中调整判断；有价值的 Output 是这些判断与行动在需要沟通时的表达。

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

Person 的 status.summary 保存当前认识概览，status.recent 保存近期交往、观察和认识修正的依据；区分明确表达和推断，保留必要背景与日期，不引用 Input ID。Chief 的 summary_person 工具更新 summary 并追加 recent；用户在 Web Persons 直接编辑同一个 status.summary，修正后的文本就是当前认识，不另存 corrections 字段。recent 只记录发生过用户修订，不复制整篇 summary。Chief 必须读取最新版本并在继续维护时尊重用户明确修正，不能用旧上下文中的推断覆盖它。身份补全、仅编辑身份和启动更新均保留现有认识。并发更新必须重读后合并，不能盲目覆盖。

summary 和 recent 只是人物资料的一部分，不代表完整的长期 profile。职责、关系、经历等资料可以按其自身语义继续组织；近期窗口的裁剪不授权删除长期资料。当前将 understanding 收敛为 summary，不预建未来的资料分类。

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

Chief 是业务角色。Conversation 的接收 Controller 与 agent Controller 分别负责输入接纳和连续执行；Chief Harness 执行 `agents/chief/` 中的 Agent，使用通用 Pi 能力以及 Personal 工具。Task / Routine 分别使用独立的 [Task Agent](../harness/task.md) / [Routine Agent](../harness/routine.md)，与 Chief 一样复用 Pi。Chief 的提示词、上下文和记忆优化方向见 [Chief Harness](../harness/chief.md)，插件机制见 [Plugin](README.md)。

## 输入与上下文

Route 的角色、工具与连续执行机制见 [Route Harness](../harness/route.md)。本节描述 Input、Route 与 Conversation 的整体协作。

Input、Output、Route 与 Conversation 都是 Personal 的普通资源。Channel / Source 提交持久 Input，单例 `Route/global` 决定把它归入哪些 Conversation。底座按资源 UID 组织执行上下文，不需要为 Route 创建内部 Session。

Route Reconcile 通过索引选择未完成路由的 Input。匹配 sessionId 或已有 originalInputId 归属时直接分派；其余 followup 给持续 Route Agent。前置 Input 尚未路由不会阻塞后续消息。Channel 的明确新话题可创建 Conversation，Source 的陌生话题线索不自动创建。

Route 专用 `route_input({ inputId, conversationUids, reason })` 一次事务写 route 结果及全部 assess 记录；空数组使用 Default，没有 Conversation 时直接建立 Default。重复确认不重置既有阶段。Route 不拥有 say、assess_input、Work 修改或文件执行工具。

Input.status 是协调事实的唯一来源，各组件留下自己的痕迹：

```ts
interface InputStatus {
  route?: {
    executionId?: string;
    startedAt?: string;
    attempts?: number;
    nextAttemptAt?: string;
    lastError?: string;
    completedAt?: string;
    result?: { conversations: ResourceRef[]; reason: string };
  };
  assess?: Record<ConversationUID, Processing>;
  handle?: Record<WorkUID, Processing & { request: WorkInputRequest }>;
}
interface Processing {
  resource: ResourceRef; // 固定 UID，不能改投同名新实例
  assignedAt: string;
  executionId?: string;
  startedAt?: string;
  lastError?: string;
  completedAt?: string;
  result?: { summary: string; disposition?: "completed" | "cancelled" | "rejected" };
}
```

未完成可能是等待、运行或待核对，不能仅凭 completedAt 缺失称为失败。Route 分类失败按每条输入退避，已到重试时间的旧输入不会被持续新输入挤掉。Chief 可能已产生副作用，不自动重放。

Conversation.address 只在由 Channel Input 创建时取首个 Input.source，后续追加不覆盖。Immediate 输入的直接回复使用该 Input.source；其它通知明确选择 target 或使用 Conversation.address。多个 immediate 地址不同时，say 必须指定 respondToInputId 或 target。路由去向、通信位置和执行授权分别判断。

Conversation.spec 保存身份、可选 address 与 trigger；status 保存下次触发时间、有界 summary / recent 与当前 execution。没有 pendingInputIds、Batch 或 recentInputIds。Web 的 pendingInputIds 是通过 Input.assess 索引推导的展示字段。

Conversation Reconcile 负责确定性协调，非确定性判断提交给持续 Chief Agent。普通输入在同一原生上下文 followup，immediate 可以 steer；timer 可在没有新输入时触发回顾。每次接纳先写 executionId，重复协调不重复提交已接纳材料。

- `assess_input({ inputId, summary, conversationSummary, workRequests? })` 完成当前 Chief 的研判，并在同一事务建立所需 handle。workRequests 按 Work UID 指定 request，含 note、action 和可选 changes；不需要 Work 时可以为空。summary 是本次研判结果，进入 Input 处理痕迹和 Conversation.recent；conversationSummary 是合并旧认识后的整体概览，替换 Conversation.summary。
- Chief 通过 read_input 读取待处理项及状态。已尝试但未确认的项保留 executionId、lastError，后续输入或定时回顾可以核对已有动作后明确确认。
- say 只创建 Output，不完成 assess；需要补充时发出问题，确认本次研判，后续回答作为新 Input。
- steer 接纳前保存身份；明确拒绝时清除本次接纳以便 followup，结果未知则保留待核对证据。模型或调用结束不等于业务确认。

原生 SDK 管理连续历史与压缩，Host 保存恢复绑定，不改写原生文件。每次 HarnessInvocation 仍独立记录期限和终态，一次执行最多两天。Route 与 Chief 隔离原生上下文，共用 Hermes 长期记忆；Route 只检索，Chief 维护。Task / Routine 仍是工作状态的权威来源。

`contextChars` 限制新 Input 预览，全文通过 read_input 分页读取；不限制整个模型 token 窗口。`summaryChars` 限制 Conversation 的累计认识，默认 4000 字符；模型应主动合并和压缩，超预算的更新会被拒绝，不通过截断生成残缺结论。定时回顾没有 Input 时，Chief 通过 summarize_conversation 更新 summary / recent；先用 read_input 获取当前上下文与版本，版本过期需重读后合并。

Input 上未完成的 route、assess 或 handle 阶段保护原始事实，全部完成后由 Host 按资源容量回收；阶段处理记录随 Input 保留，入站去重回执在独立窗口内继续生效。Output 的待投递状态独立保护输出，已送达输出不因连续 loop 永久保留。Web 展示现存 Input 的原始事实、消费状态和错误，从 Ledger 展示执行轨迹。错误不会自动向用户反复发送失败通知。

Input 路由完成、Input 业务消费、工作目标完成、Harness 执行结束与 Output 送达分别记录。

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

Chief 只通过 say 沟通。问题也是普通 Output，不创建挂起的 Interaction，不等待同一次 Harness 执行恢复；用户回答是新的 Channel Input。Input 不含 replyTo，也不会把下一条消息自动匹配为某个待答问题。Chief 根据新到达的输入与上下文判断其含义。

Web 与 Lark 使用相同的交流流程；群里用户后续回复仍需 @Aide。Hooks 信任和 Harness 工具权限通过网页独立的 Approval 区域处理，普通聊天不会授予这些权限。

Source 观察没有用户指令的地位。Chief 应读取详情、查询已有 Work；在已有委托内可以推进工作，缺少目标或授权时询问。不值得打扰的观察可调用 `assess_input` 保存原因并确认消费，无需向 Channel 发消息。

普通回复由 Chief 的工具调用 `say` 创建独立 Output，界面按 Conversation UID 查询历史输出。Input 与 Output 的关联可选且多对多。POST `/messages` 返回入站持久回执，业务结果异步出现；没有每次固定发出的“已创建事项”回复。模型进度不会重复投递为最终回复。

Chief 可能调用有副作用的工具，因此运行中断、失败或重启均不自动重放。状态和失败提示保留，用户核对后用新消息重新交办。同一输入 id 的传输重投永远不作为业务重试。调用栈不跨重启恢复，已接纳但未确认消费的 Input 保留 lastError；Work 的结果处理见下文。

## 研判与办理

Chief 可以直接处理、创建或删除工作。将现有 Input 交给已有 Work 时，通过 assess_input 同时完成研判和建立 handle，原始事实只保存一份。一个 Input 可以由多个 Chief 独立研判，也可以交给多个 Task / Routine 办理；每个资源按 UID 拥有自己的记录。

request 支持 context、update、pause、resume、answer；交接说明 note 与原文分开保存，update 的 changes 包含 title、instruction、trigger。Source 观察只能提供 context，不能作为控制授权。已有 handle 的请求不可替换；后来的独立请求必须有新 Input 身份。

`request_work({ workId, text, action?, changes? })` 用于 Chief 独立形成的新请求，创建 origin=chief 的新 Input，按工具调用身份去重，直接建立目标 handle。针对已收到 Input 的交接使用 assess_input，避免复制原始消息。

Task / Routine Watch Input.handle 并按自身 UID 索引读取未完成记录。Reconcile 原子应用确定性请求并记录 appliedAt；暂停或拒绝请求可直接完成，其余材料必须由执行确认。Task / Routine 的后续输入通过原生 followUp / steer 进入当前 invocation，分别经 report_task / report_routine 独立确认。原始 Input 不复制到 spec。

暂停、结果未知的工作可吸收事实但不因此恢复。显式更新可为已完成目标提出新的要求；失败请求保存 rejected 原因而不阻塞后续输入。目标删除会把剩余 handle 标为 cancelled。

## Task / Routine 与 Work

Work 接住与自身目标相关的新事实、用户补充和决定，保留来源及有助于下一步判断的历史。每次 Reconcile 结合目标、已有进展和新事实，决定哪些动作现在可以执行、哪些需要等待、提醒或询问用户。Task 的收敛目标是整个有限目标完成；Routine 的收敛目标是当前轮次完成，一轮可以跨越多次执行和等待。Harness 返回或一次 Reconcile 结束，只表示本次处理结束，完成状态还需满足对应的业务条件。

Task / Routine Controller 用持久会话持续办理 Input 或已到期的定时触发，先保存 execution 与接纳回执，再唤醒各自的专属 Agent。report_task / report_routine 原子确认进展及明确列出的 Input；say 单独创建 Output。两者跨执行等待后按 UID 重读资源，保留最新指令与暂停状态；版本冲突只重试提交，不重复执行外部工作。

工具报告 ask 时，工作保存为 waiting 并结束本次调用，用户回答后再唤醒；报告 wait 时保存动态唤醒时间。Routine 完成本轮后继续等待下一次触发，Task 完成后仍可在回收前接收相关 Input。事件触发更新匹配的 Routine，由其 Controller 推进。

`task/` 与 `routine/` 各自保存 CRD 定义（`model.ts`）和 Reconcile（`reconcile.ts`）：Task 完成后进入 done，Routine 完成本轮后回到 scheduled，并按自己的触发规则计算下次时间。两者复用 `loop.ts` 的持续执行、接纳和恢复机制，以及 `work-report.ts` 的原子进展回执。领域回执和目标状态均由 Personal 拥有。

资源类型决定身份；Task 没有周期触发配置，Routine 必须有 cron 或事件触发。Work 工具与网页聚合这两类资源，对外仍返回 task / routine 分类。Chief 的会话处理观察 Personal 定义的 Conversation 资源。

改变工作类型由 Chief 组合现有工具：读取原工作的目标与结果，创建目标类型的新工作，再按用户意图暂停或删除原工作。新工作使用独立 id 和资源执行上下文，相关上下文写入指令；保留原工作可查看完整历史，删除则将输入回执保留到 Conversation，独立 Output 继续投递和展示。各步分别持久化，不承诺跨资源的原子转换；中断后应查询现状再继续。暂停和删除都不取消已经运行的外部动作。

## Task 会话与静默回收

Task.status.agent 保存 `{ harness: "task", sessionId }`；原生持久化由 Harness 的 SDK 完成。创建 Task 时绑定 initialInputId 和 handle，不提前完成 Chief assess；创建重试按工具调用身份去重，同一 Input 可以创建不同目标。

执行结束且没有下一条可执行 Input 时开始 idleSince 计时；默认 5 分钟释放 agent 句柄，再从 agentStoppedAt 起保留 Task 24 小时。新 Input 分派原子清除计时并恢复同一会话。未处理 Input、明确等待或待核对状态阻止资源回收。两段时间由 plugins.personal.task 配置。

回收通过带 UID / resourceVersion 前置条件的 delete 请求设置 deletionTimestamp。Chief 不列出或分派 deleting Task；分派与回收互相校验版本，进入删除流程后不可恢复。删除 Reconcile 完成清理后 finalize Task，独立 Input、Output 和 SDK 历史各自管理保留。完整机制见 [Task Agent](../harness/task.md)。

## Routine 会话与静默释放

Routine.status.agent 保存 `{ harness: "routine", sessionId }`，由原生 SDK 初始化、持久化和恢复。cron 到期或事件 / Chief 分派的 Input 唤醒 Routine Agent。done 只完成本轮并回到 scheduled；cron 重新计算下次触发时间，纯事件职责等待新事件。ask / wait 可以让同一轮跨越多次执行。

执行结束、没有下一条可执行输入后开始静默计时；默认 5 分钟释放 agent 句柄。Routine 的职责资源继续保留，不设置静默回收期限。新触发清除计时，复用同一原生会话；显式删除才进入 deletionTimestamp / finalize。详见 [Routine Agent](../harness/routine.md)。

## 完成依据与交付

Task 的目标应包含可判断的完成条件；Routine 应说明每轮检查什么、哪些变化需要处理或通知。执行者返回的结论需要结合工具结果、产物和外部状态解释，例如 PR 是否已合入、测试是否通过、文件是否包含预期内容。结果格式校验保证返回值可处理，业务完成条件决定目标是否达成。

Personal 的 Controller 负责解释执行结果并推进工作状态，Core 保存执行事实。领域专用验收由对应 Controller 通过 Core Verb 查询外部系统或请求验证，开放问题则由 Harness 调查并提供依据。无法确认的部分保留为待核对或等待，向用户说明缺口。

工作完成和消息送达分别记录。通知失败只影响交付，不能让已完成的业务动作重新执行；交付应说明结果、依据以及仍需用户决定的事项。

## Work 工具与执行结果

| 工具 | 行为 |
| --- | --- |
| `list_work` | 列出绑定会话的 Task / Routine |
| `read_work` | 读取目标、状态、历史、revision 和待回答问题 |
| `create_input` | 记录 Chief 在已有委托内形成的独立决定，返回 inputId |
| `create_work` | Task 必须传入 inputId，原子创建 Task 和初始 handle；Routine 沿用 trigger |
| `assess_input` | 确认 Input 研判，原子建立 Work handle |
| `request_work` | 为独立新请求创建 Input，由 Work Reconcile 消费 |
| `delete_work` | 请求删除，停止后续调度并保留已交付消息 |

WorkService 绑定宿主确定的 conversationId，模型不能传入其它会话范围。读操作不唤醒执行，输入追加通知对应 Reconcile，删除需要最近读取的 revision。输入追加不直接改变业务状态。删除前归档消息和输入回执，已运行回调不能重建被删资源。

Task / Routine 分别通过 report_task / report_routine 明确确认进展与 Input，finalText 不代替业务回执。执行中断或已接纳 Input 未确认时进入 uncertain；没有 Input 的定时执行也必须报告本轮结果。两者均等待核对后明确继续，不自动重放。业务等待用户则保存为 waiting，收到回答后由 Reconcile 继续，能够跨服务重启恢复。

Chief 问题作为 Output 持久保存，用户可在重启后发送新 Input 继续；没有需要恢复的业务问答调用栈。Task / Routine 的 waiting 保留领域阻塞状态，由 Chief 根据新输入决定如何提交 assess_input。上下文结合近期消息、工作记录及连接器查询，工作状态以 Task / Routine 为准。

### 中断与有界消费

Input.status 的未完成阶段就是待办事实，不在消费者资源里另存 ID 队列。Host 通过 Definition.indexes 查询阶段与资源 UID，索引与资源在同一事务更新。全部 route、assess、handle 完成后 Input 才能回收；删除目标明确结束其遗留阶段。完成回执随 Input 过期，入站去重回执在独立窗口内保留。

普通输入持续 followup，immediate 尝试 steer；原生历史由 SDK 压缩，Conversation 保留有界近期摘要，Work 保存有界已吸收材料。模型结束、研判完成、工作目标达成和 Output 送达是独立事实。

## 验证

`tests/chief.test.ts` 验证真实 Runner 的接收、隔离和失败不重放；Harness 与平台使用替身。`tests/pi-agent.test.ts` 另覆盖真实 Pi SDK 与 Chief 工具。`tests/conversation-intake.test.ts` 覆盖统一接收、超过旧上限、重投去重，以及 say 提问后跨重启用新 Input 继续。`tests/harness-approval.test.ts` 验证原生权限拒绝、校验和取消。真实环境验收见 [E2E](../e2e.md)。


## 有界认识与近期依据

Conversation、Task、Routine、Person 共用 status.summary 和 status.recent 的字段约定。summary 表达截至当前仍有价值的整体认识与进展；recent 是近期处理依据，条目包含 at 和 text，保存具体观察、判断、动作或结果。当前目标、委托、人物身份等结构化事实仍由各资源原有字段承担。两者均不承诺完整历史，原始 Input、Output 和执行轨迹分别保留。

Personal 的共享上下文 Schema 在每次持久写入时执行预算：summary 最多 16000 字符（Conversation 可配置更低预算），recent 最多 40 条且正文总计最多 16000 字符。超出窗口时保留较新记录，边界条目标记省略；Host 负责执行 Schema 和整体资源容量，不替业务总结。需要长期保留的认识应由模型合并进 summary、结构化状态或长期记忆，不要求每条旧记录都变成 summary。

Task / Routine 与 Route / Chief 通过保存的 sessionId 延续原生会话。Work Agent 按需用 read_task / read_routine、read_conv、read_input 读取职责与材料；read_input 每页列出 20 条待处理记录，单条材料每页 8000 字符，并返回 nextOffset。材料分页不代表完成；只有明确的 report 才能确认输入。

Work 的请求应用和上下文处理分开记录：Input.handle.appliedAt 表示确定性请求已应用，避免恢复时重复修改状态；暂停或拒绝请求可直接完成。需要执行的材料仍保持待处理，进入执行时将底座 executionId 写到所选 Input。Task / Routine 通过 report_task / report_routine 将累计 summary、recent 与指定 Input 的完成痕迹原子提交，say 独立创建 Output。执行期间新到的 Input 独立接纳、独立确认；未报告的输入保留待处理。中断或未确认时保留输入与错误，Work 进入待核对状态，不自动重放；显式恢复后才继续。暂停状态不会被普通观察自动恢复；Task 的 done 可承接新的相关 Input。

Routine 事件也形成 Input，依据订阅建立 handle；不再维护 Work 内部的事件历史或去重数组。入站去重复用 InputStore 的独立有界回执窗口，Input 被回收后，窗口内重投不会重建处理。Task / Routine 的目标和调度生命周期保持独立。
