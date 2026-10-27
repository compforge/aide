# Personal：理解人，承接目标，持续推进

Personal 是 Aide 的内置个人助手插件。Input 带来内容、人物和地址；Aide 结合输入性质、已有委托与处理进展作判断，必要时向相关 Address 产生 Output。

## 从大量输入到有价值的输出

Aide 从 Channel 和 Source 持续接收输入，围绕话题理解和推进事情，再通过 Channel 向相关的人发出有价值的输出，把成百上千条输入转化为人的注意力可以承受的沟通。判断价值要结合用户的目标、已有委托与当前处境，让用户把注意力放在需要了解和决定的事情上。

这个过程包含归属判断、关联上下文、核实事实、研判影响、推进工作和选择沟通时机。有些 Input 只更新认识、记忆或已有工作的进展；多条 Input 可以汇聚成一条 Output，一条 Input 也可能在持续跟进中促成多次 Output。静默处理同样可以有明确的判断和结果。

Input 同时承载收到的事实和围绕这份事实的处理进展。原始内容保持不变，各组件将自己负责环节的处理时间、去向、结论及异常写入 Input.status。沿着一条 Input，可以知道它被分派到哪些 Topic、哪些 Chief 已经研判、哪些 Task / Routine 正在办理，以及还有什么尚未完成。这为协作、恢复与问题排查提供共同依据。

可以借用 Kubernetes Pod 的直觉理解这种协作：多个组件围绕同一个持久对象工作，各自在 status 中留下负责环节的痕迹。Aide 中，route、assess、handle 分别表达路由、研判和办理。Input 保存这些环节的状态与结果摘要；详细执行轨迹、工作目标与进展、输出正文分别由执行记录、Work 和 Output 承载，并遵循各自的保留策略。

这是理解 Aide 信息处理过程的一个视角。Aide 的完整职责还包括理解人、承接目标、持续行动以及在变化中调整判断；有价值的 Output 是这些判断与行动在需要沟通时的表达。

## 对象与主流程

Personal 的业务主线是：

**Channel / Source → Input → Topic → root Chief → Task / Routine 或 Output**

Channel / Source 将交流和观察形成 Input，保留事实与来源；Route 确定 Input 的 Topic 归属；当前 root Topic 的 Chief 综合子树输入，在已有授权范围内直接处理，或交给 Task / Routine 持续办理。Chief 与工作 Agent 在需要沟通时产生 Output，也可以静默完成研判或推进工作。

Weave 作用于 Topic 之间的关系：把值得共同理解的主题组织到新父 Topic 下，使后续输入由共同 root 的 Chief 综合处理。Input 的原始 Topic 归属保持稳定，实际处理位置随主题树解析到当前 root；主题组织、人物身份、通信目的地和授权分别表达各自的事实。

![Personal 的输入、路由、研判、办理与输出](../assets/personal-flow.svg)

| 对象 | 承担的职责 | 详细设计 |
| --- | --- | --- |
| Input | 收到的事实，以及各组件的处理痕迹 | [输入](input.md) |
| Weave | 组织相关主题，促进跨来源知识融合，收敛独立处理上下文 | [Weave](weave.md)、[主题树](topic.md) |
| Route | 为输入选择一个话题，无合适归属时使用 Default | [路由](route.md) |
| Topic / Chief | Topic 保存主题认识，Chief 在 root 综合研判子树输入，直接处理或委托工作 | [主题](topic.md)、[Chief](chief.md) |
| Task / Routine | 有限目标与持续职责的独立生命周期 | [Task](task.md)、[Routine](routine.md) |
| Person | 人物身份、可选 Me 标记和持续积累的认识 | [人物](person.md) |
| Output | 已决定表达的内容、对象、地址与投递状态 | [输出](output.md) |

Route 的确定性规则直接分派，其余交给持续 Route Agent。各 Agent 通过工具明确确认业务进展，通过 say 创建 Output，投递器负责发送和回执。

Personal 采用 [工具驱动与持续接纳](../harness/README.md#agent-的使用方式与持续职责) 的 Agent 使用方式：Chief 服务于 root Topic 的综合理解与研判，Task Agent 服务于有限目标，Routine Agent 服务于持续职责。Reconcile 负责确定性协调，Agent 负责非确定性判断；新动向通过 followUp / steer 加入运行中的会话，以 assess_input、report_task / report_routine 和 say 分别提交研判、办理进展与沟通。业务完成以这些回执为准，最终文本用于内部执行摘要。

## 主动性与上下文

Aide 的主动性围绕一个动作展开：把发生的事放入合适的上下文（place it in context），结合那里已有的关注、委托、历史和进展，决定推进、更新、沟通、等待或忽略。归位让一次新变化接上此前的工作。

| 上下文 | 承载什么 | 协调与判断的职责 |
| --- | --- | --- |
| Topic | 一个话题的交流、近期关注与相关委托 | 理解新输入或定时回顾，直接处理简单事情，将持续工作交给 Work |
| Task | 有限目标、完成条件、相关事实、执行历史与当前阻塞 | 持续推进目标直至完成 |
| Routine | 持续职责、历史基线与当前轮次的目标和进展 | 推进当前轮次直至完成，再等待下一轮触发 |

归位可以涉及零个、一个或多个上下文，也可以止于 Topic。Input 保留原始事实与来源；关联上下文时，保存引用或将相关事实、用户决定承接到对应资源。需要持续跟进时优先关联已有 Work，再按需要创建 Task / Routine。目标与进展由这些资源持有，Harness 的会话和记忆帮助理解它们。

例如 executor 的 Pod 发生变化，Route 先把输入归入关注该服务的话题，Chief 再判断后续处理。若话题下已有“跟进 OOM 修复”的 Task，就将变化作为新证据交给它继续核实；若属于稳定性巡检，则进入 Routine 当前轮次的观察；只有近期关注时，Chief 可以核实后直接提醒。没有改变判断的新信息可以静默处理。

## 持续委托

Personal 围绕用户交付的目标持续负责。普通交流可以直接结束；需要保留目标、等待变化并继续推进的事情进入 Work。创建工作前先检查已有委托，将补充信息、用户决定与外部变化关联到同一件事，避免每次触发都重新建任务。

Task 与 Routine 按目标的结束条件区分。Task 达到完成条件后结束，即使它持续一周、经历多次执行或等待，仍然是一个 Task。Routine 承担持续职责，每轮执行结束后继续等待下一次条件满足；频率只是触发方式。例如“跟进这个 PR 直到合入”是 Task，“持续关注我的 PR，有新阻塞就处理或通知”是 Routine。

一项委托的连续性包括目标、进展、已经发生的动作、等待条件和结果依据。执行、等待用户、等待外部变化及恢复都属于同一项工作；每次推进都从最新事实开始。外部动作结果不确定时先核对，避免把已经生效的操作重新执行。停止定时回顾、暂停工作和撤销外部动作分别作用于触发、业务调度和外部系统。

Source 和 trigger 提供重新判断的机会。已有委托决定可以继续承担的工作；相关的新机会可以向用户提出，用户的兴趣与历史偏好用于理解背景。Chief 的主动判断与沟通原则见 [Chief](chief.md#主动判断与沟通)。

## 有界认识与近期依据

Topic、Person、Task、Routine 共用两种独立的认识。summary 保存长期有效、低频变化的认识，不保证始终正确或完整；只有形成值得长期保留的新认识或需要修正旧认识时才更新。字数不足时，比较新旧内容的重要性、稳定性和长期价值，新内容不能仅因更新或更具体而挤掉更值得保留的旧认识。Task 的长期价值相对于该目标的生命周期，结构化目标、身份、授权和业务状态仍由各自字段承担。

recent 保存近期事项的 Note。每条有 id、createdAt、updatedAt、text；一个事项跨多个 Input 持续更新，例如开始、完成 50%、报告完成。text 是该事项完整的当前认识，保留实际作者、必要依据和不确定性，区分报告完成与已验证完成。Note 可以在原始 Input 释放后继续承接近期上下文；事项完成不自动提升为 summary。

summarize_topic、summarize_person、summarize_task、summarize_routine 修订各自的 summary，不写 recent。upsert_note 不传 noteId 创建，传入则更新已有事项；写入需要读取目标取得的资源版本，创建重试复用工具调用身份。更新会刷新 updatedAt 并将该事项放到窗口末端，createdAt 保留。不存在或已淘汰的 noteId 拒绝更新，不隐式重建。

四类资源共用 Note 结构和容量规则，但工具描述与范围由其 Agent 决定。Chief 可维护当前根及子 Topic，或显式选择已读取的 Person；Task/Routine 的目标由宿主绑定，模型不能指定其它资源。维护认识不确认 Input 办理、不完成 Work，也不授予执行权限。

recent 按更新时间保留最多 40 条、合计 16000 字符；优先保留最新事项，必要时截断较旧条目的正文。summary 的存储上限为 16000 字符，Topic 另受配置的 summaryChars 约束。常驻背景只展示有界预览，省略内容通过对应读取工具查询。保留预算不是要求每轮写满窗口，临时观察也不要求改写 summary。

report_task / report_routine 原子提交本次 report、业务状态和明确列出的 Input 回执，并保存 lastReport 供恢复和进展查询；它们不替换 summary、不自动追加 Note。用户沟通仍独立通过 say。Person 的人工修正直接更新同一 summary，保留用户来源；身份合并保留并归并已有 Note，不自动制造事项笔记。

## 运行与验证

Personal 的资源定义与 Controller 经普通 Plugin 契约注册；Source、Route、Topic、Task 和 Routine 各自协调资源，Person 共享目录按需读写。Controller 之间通过资源变更与索引协作，依据持久回执判断业务完成状态。

框架机制见 [Plugin](../plugin/README.md)，原生执行边界见 [Harness](../harness/README.md)，外部接入见 [Connector 与 Source](../connector/README.md)。配置阈值集中在 [配置](../configuration.md)，真实模型和平台效果按 [E2E](../e2e.md) 验收。各主题文档链接相应自动测试；替身测试不证明真实提供方连通或模型判断质量。
