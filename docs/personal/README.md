# Personal：理解人，承接目标，持续推进

Personal 是 Aide 的内置个人助手插件。Input 带来内容、人物和地址；Aide 结合输入性质、已有委托与处理进展作判断，必要时向相关 Address 产生 Output。

## 从 Input 到认识与成果

Aide 围绕用户目标，将大量零散、暂时性的信息整合为可持续使用的认识，并据此判断、行动和沟通。单条消息或观察的价值往往要与其它信息结合才能确定；整理需要保留重要变化、事实来源、分歧与未决问题，让用户把注意力放在需要了解和决定的事情上。

认识与输出形成持续循环：

```text
最新 Input + 已有 Note
          ↓ 关联、核实、判断
          ├─ 按需更新 Note
          │    ├─ 近期：持续跟进具体事情的进展、依据与未决问题
          │    └─ 长期：关于主题、人物或工作的稳定认识（summary）
          ├─ 按需调整 Topic tree
          └─ 产生必要的 Output：答复、结果、提醒或待决事项

更新后的 Note 参与下一次判断
```

Input 保留收到的原始内容；Agent 结合已有 Note 与最新 Input，修订对事情的认识，并判断是否需要行动或沟通。近期与长期认识统一保存为 Note：近期 Note 跟进具体事情，长期摘要 Note 通过 summaryOf 关联 Topic、Task、Routine 或 Person。近期和长期表达内容的使用跨度，不代表固定 TTL，也不增加另一套正文存储。

这是持续更新的过程，不要求每条 Input 先写 Note 才能答复。简单问题可以直接回答；认知更新可以静默发生。Output 基于当前相关的 Note 与最新事实按需形成，不能只依赖可能尚未更新的摘要。Topic tree 表达哪些事情值得共同理解、哪些需要独立跟进。

例如，关于一次发布的讨论、评审与部署反馈形成多条 Input，相关 Note 持续记录这次发布的进展、判断依据与未决问题。得到验证的发布约束可以进入 Topic 的摘要 Note，人物明确表达并确认的职责可以进入 Person 的摘要 Note；这些事项与已有主题的联系也为 Topic tree 的调整提供依据。

Topic tree 本身也是认知的一部分。同样一组发布信息，财务负责人可能围绕预算与成本组织，技术负责人可能围绕系统与可靠性组织。已有认识和结构帮助新输入找到位置，新证据与工作结果又推动认识和结构修订，内容与组织方式一起演化。

认知服务于实际成果：回答问题、推进工作、帮助决策或及时提醒。Output 专指已经决定向外表达的内容；工作进展和认识更新各自保存，可以静默发生。多条 Input 可以汇聚成一条 Output，一条 Input 也可能在持续跟进中促成多次 Output。效果取决于判断是否有依据、工作是否推进、重要变化是否被识别，以及用户是否减少重复背景和无效关注。

## 对象与主流程

Personal 的业务主线是：

**Channel / Source → Input → Topic → root Chief → Task / Routine 或 Output**

Channel / Source 将交流和观察形成 Input，保留事实与来源；Route 确定 Input 的 Topic 归属；当前 root Topic 的 Chief 综合子树输入，在已有授权范围内直接处理，或交给 Task / Routine 持续办理。Chief 与工作 Agent 在需要沟通时产生 Output，也可以静默完成研判或推进工作。

Weave 作用于 Topic 之间的关系：把值得共同理解的主题组织到新父 Topic 下，使后续输入由共同 root 的 Chief 综合处理。Input、Task、Routine 的当前归属由 status.topic 保存；Chief 可在树内调整，实际处理位置随主题树解析到当前 root；主题组织、人物身份、通信目的地和授权分别表达各自的事实。

![Personal 的输入、路由、研判、办理与输出](../assets/personal-flow.svg)

| 对象 | 承担的职责 | 详细设计 |
| --- | --- | --- |
| Input | 收到的内容、来源证据与处理痕迹 | [输入](input.md) |
| Note | 近期事项认识与长期稳定认识的统一载体，以稳定 ID 承接后续变化 | [认识笔记](note.md) |
| Weave | 组织相关主题，促进跨来源知识融合，收敛独立处理上下文 | [Weave](weave.md)、[主题树](topic.md) |
| Route | 为输入选择一个话题，无合适归属时使用 Default | [路由](route.md) |
| Topic / Chief | Topic 保存长期认识和主题组织关系，Chief 在 root 综合研判子树输入，直接处理或委托工作 | [主题](topic.md)、[Chief](chief.md) |
| Task / Routine | 有限目标与持续职责的独立生命周期 | [Task](task.md)、[Routine](routine.md) |
| Person | 人物身份、可选 Me 标记和持续积累的认识 | [人物](person.md) |
| Output | 已决定表达的内容、对象、地址与投递状态 | [输出](output.md) |

Route 的确定性规则直接分派，其余交给持续 Route Agent。各 Agent 通过工具明确确认业务进展，通过 say 创建 Output，投递器负责发送和回执。

Personal 采用 [工具驱动与持续接纳](../harness/README.md#agent-的使用方式与持续职责) 的 Agent 使用方式：Chief 服务于 root Topic 的综合理解与研判，Task Agent 服务于有限目标，Routine Agent 服务于持续职责。Reconcile 负责确定性协调，Agent 负责非确定性判断；新动向通过 followUp / steer 加入运行中的会话，以 assess_input、report_task / report_routine 和 say 分别提交研判、办理进展与沟通。业务完成以这些回执为准，最终文本用于内部执行摘要。

## 资源状态与组件协作

各组件围绕持久资源协作，将负责环节的处理时间、去向、结论及异常写入状态。Input 的 route、assess、handle 分别记录路由、研判和办理；详细执行轨迹、工作目标与进展、输出正文分别由执行记录、Work 和 Output 承载。每个对象的字段、版本、维护者与生命周期在其专属文档中展开；通用并发、Conditions 和版本演进见 [Resource](../plugin/resource.md)。

Input 保存原始事实，Task 承担有限目标，Routine 承担持续职责，Topic 保存主题认识和组织关系。Route、Chief、Weave 围绕对象工作；原生执行结束、Input 研判完成、目标达成和 Output 送达分别记录。

| 共享片段 | 适用对象与边界 |
| --- | --- |
| status.topic | Input、Task、Routine 的唯一当前 Topic UID 引用；Topic 使用 spec.parentRef 表达父子关系 |
| summary / Note | 各资源的长期认识与独立事项认识；recent 为查询视图，Input 的解释留在研判回执 |
| agent / execution | Topic、Task、Routine、Route、Weave 的原生会话与执行；Input 只在处理回执中引用执行 |
| organization | Input、Task、Routine、Topic 最近一次组织调整的操作者、原因、时间和前后关系 |
| conditions | Input、Task、Routine、Topic 按各自业务语义声明条件；不强求同一组状态判断 |

Personal 在 plugins/personal/conditions.ts 实现条件更新规则，在 status.ts 构造自身负责的事实与条件；使用现有 ResourceClient 提交，不让 Host 理解 Personal 的业务语义。Work DTO 的 status、nextAt、question、revision 是展示投影，CRD 分别保存暂停期望、等待、执行和业务结果，以 metadata.generation 表达 spec 修订。

各对象文档按“整体定位、CRD（如有）、Reconciler（如有）、Agent（如有）”组织。Agent 下的 Context View 是文本形式的 prompt 大纲，说明 system 和 user 各由哪些部分构成，以发现重复、过期、缺失或越界的上下文。它与执行历史的 SessionView、单次业务证据的 JobView 分工不同；实际请求仍以录制证据为准。

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

Topic、Task、Routine、Person 的长期认识保存在 summaryOf 指向该对象的 Note 中，对象不再保存 summary 字段。正文与 people 等关联信息统一存于 Note，统一 Note 的元数据、引用与保留契约见 [Note](note.md#作为-summary-的-note)。选择保留内容时比较重要性、稳定性和持久价值；较新或更详细不自动优于已有认识，用户明确修正优先于旧推断。

具体事项的当前认识保存为独立 [Note](note.md)，同一事项随新输入持续更新。统一 upsert_note 用 subject 关联 Topic / Work、people 关联人物。recent 是近期查询窗口，不持久化在四类资源中；Note 正文完整保存，生命周期由自身容量策略管理。summary 与 Note 分别校验自身内容，调度更新不制造模型侧误冲突。

Note 通常比单条 Input 跨越更长的跟进过程，summary 选择比具体事项更长期的认识。list_notes 发现 recent 之外的事项，move_note 调整其归属；Note 变化由有界回顾流程交给 Chief，review_notes 确认已检查的内容版本。具体见 [Note](note.md#事项归位与提炼回顾)。

report_task / report_routine 只原子提交办理报告、业务状态与 Input 回执，不自动更新 summary 或 Note。维护认识也不确认 Input、不完成 Work、不授予新的执行权限。详细字段、工具、预算、并发和生命周期契约见 [Note](note.md)。

## 运行与验证

Personal 的资源定义与 Controller 经普通 Plugin 契约注册；Source、Route、Topic、Task 和 Routine 各自协调资源，Person 共享目录按需读写。Controller 之间通过资源变更与索引协作，依据持久回执判断业务完成状态。

框架机制见 [Plugin](../plugin/README.md)，原生执行边界见 [Harness](../harness/README.md)，外部接入见 [Connector 与 Source](../connector/README.md)。配置阈值集中在 [配置](../configuration.md)，真实模型和平台效果按 [E2E](../e2e.md) 验收。各主题文档链接相应自动测试；替身测试不证明真实提供方连通或模型判断质量。
