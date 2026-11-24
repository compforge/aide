# Personal：理解人，承接目标，持续推进

Personal 是 Aide 的内置个人助手插件。Me 与 Aide 单聊时，[Gate](gate.md) 可以跨 Topic 回答问题，也可以把请求交给负责领域。下图描述领域 Chief 如何处理交办、消息与外部观察。

## 从 Input 到认识与成果

从本轮到下轮，Chief 可以围绕同一条 Input 继续办事，也可以留下供以后判断的认识。Input 保留当时收到的内容和来源，Route 为领域输入确定 Topic 归属，Secretary 按需将 Deferred 待办整理成批。当前领域 root 的 Chief 结合新材料、已有 Note 和相关工作，判断当下要办什么，以及哪些认识值得留给以后。

![从本轮研判到下轮研判的两条泳道。办理线上，Chief 可当轮办妥、委托 Agent 或自己跟进，按需对外沟通。认识线上，普通 Note 供下次按需查证，对象的 Summary Note 提供默认背景。](../assets/personal-flow.svg)

### 办理与沟通

按响应节奏，办理可以当轮完成，也可以在本轮之后继续。两种节奏由同一个 Chief 判断。

- **当轮响应（System 1）**。现有上下文和当轮工具足以答复或办妥时，Chief 直接处理，需要表达就创建 Output。例如 Me 问「这次审批有结果了吗」，已有审批回执就可以当轮回答。
- **后续处理（System 2）**。这轮结束后还有责任要承担时，Chief 判断下一步是推进一个目标、履行反复发生的职责，还是等具体事项有了进展再核实。一次即时答复也可以伴随后续安排。

#### 后续处理的三种责任

Chief 处理一条 Input 后仍要承接的责任统称 Work。先判断由谁推进，再选择种类。

| Work | 谁推进 | 何时收尾 | 例子 |
| --- | --- | --- | --- |
| [Task](task.md) | Chief 将有限目标委托给 Task Agent | 目标达成即结束，可以跨多轮执行和等待 | 补齐并提交材料，以提交回执确认完成 |
| [Routine](routine.md) | Chief 将循环职责委托给 Routine Agent | 当轮完成后等待下一次时间或事件触发 | 每周五汇总本周的审批结果 |
| [Ongoing](ongoing.md) | 领域 Chief 留下事项，自己跟进 | 有下文就更新进展，有结论就收尾 | 材料已提交，周五核实这次审批结果 |

Chief 用 `list_work` 查找已有责任。需要新增时，`create_work` 在当前 Topic 下创建对应资源并返回。Task 和 Routine 各自的 Reconcile 根据资源状态调度专门的 Agent。后来收到与已有委托相关的材料，Chief 可用 `append_input` 转交原始 Input。Ongoing 的新进展由 Chief 直接记录。约定时间到了，Secretary 递交 `aide:followup`，仍由 Chief 查证、回应并决定是否收尾。需要沟通时，Chief 或受托 Agent 创建 Output。见[输出](output.md)。

### 认识与沉淀

Chief 在处理 Input 时按需留下普通 Note，记录对具体事项的初步认识、依据和待核实之处。后续材料可以修订同一篇 Note。处理 `aide:curate` 时，Chief 对照来源和相关 Note 核实事实、归类、合并重复内容，并复核披露范围。整理过的普通 Note 可以就是这件事的完整记录。具体生命周期见[梳理与提炼](note.md#梳理与提炼)，分类与投递契约见[披露边界](disclosure.md)。

#### 有界认识与近期依据

Chief 空闲时，Secretary 安排 `aide:summary` 复核一个 Topic、Person 或 Address。下次接触这个主题、人物或场合时，哪些认识值得默认读到？已有判断是否仍然成立？能跨事项使用、证据充分的结论才写入该对象的 Summary Note，过时的判断随之修订。从一次事项经历推导长期判断时，先核实其结果与适用范围。Task 和 Routine 各自维护本工作的摘要。对象视角与读取契约见[作为 summary 的 Note](note.md#作为-summary-的-note)。

普通 Note 供后续判断按需查阅，Summary 提供紧凑的默认背景。Topic tree 决定哪些材料值得放在一起理解。`aide:organize` 在主题范围变化时调整树结构和材料归属，之后复核摘要时按当前范围判断。见[Topic 的材料归属与处理责任](topic.md#材料归属与处理责任)。

### 跟进未完结的事项

`aide:followup` 把办理进展带回对事情的认识。收到「材料已提交，预计周五有答复」时，Chief 可以创建 Ongoing 并安排周五核实。到时先查新 Input 和相关 Work 的结果。有结论就把结果和依据记回同一 Ongoing 并收尾，审批仍在进行就按进展安排下一次核实。缺少影响判断的事实时，Chief 私下问 Me，答复作为新 Input 回到同一事项。

即使连着几个周五都要查询，这些核实仍属于同一次审批。审批一旦有了结论，这项跟进就结束。

## 主动性与上下文

Aide 的主动性围绕一个动作展开：把发生的事放入合适的上下文（place it in context），结合那里已有的关注、委托、历史和进展，决定推进、更新、沟通、等待或忽略。归位让一次新变化接上此前的工作。

| 上下文 | 承载什么 | 协调与判断的职责 |
| --- | --- | --- |
| Topic | 一个话题的交流、近期关注与相关委托 | 理解新输入或定时回顾，直接处理简单事情，将持续工作交给 Work |
| Task | 有限目标、完成条件、相关事实、执行历史与当前阻塞 | 持续推进目标直至完成 |
| Routine | 持续职责、历史基线与当前轮次的目标和进展 | 推进当前轮次直至完成，再等待下一轮触发 |

归位可以涉及零个、一个或多个上下文，也可以止于 Topic。Input 保留原始事实与来源；关联上下文时，保存引用或将相关事实、用户决定承接到对应资源。需要独立办理时优先关联已有 Work，再按需要创建 Task / Routine。目标与进展由这些资源持有，Harness 的会话和记忆帮助理解它们。

例如 executor 的 Pod 发生变化，Route 先把输入归入关注该服务的话题，Chief 再判断后续处理。若话题下已有“跟进 OOM 修复”的 Task，就将变化作为新证据交给它继续核实；若属于稳定性巡检，则进入 Routine 当前轮次的观察；只有近期关注时，Chief 可以核实后直接提醒。没有改变判断的新信息可以静默处理。

## 对象与主流程

Weave 作用于 Topic 之间的关系：把值得共同理解的主题组织到新父 Topic 下，使后续输入由共同 root 的 Chief 综合处理。Input、Task、Routine 的当前归属由 status.topic 保存；Chief 可在树内调整，实际处理位置随主题树解析到当前 root；主题组织、人物身份、通信目的地和授权分别表达各自的事实。

| 对象 | 承担的职责 | 详细设计 |
| --- | --- | --- |
| Input | 收到的内容、来源证据与处理痕迹 | [输入](input.md) |
| Secretary | 确定性整理待办，准备业务批次与内部维护请求 | [秘书](secretary.md) |
| Batch | Secretary 安排的一组待办及其接纳、完成生命周期 | [批次](batch.md) |
| Note | 近期事项认识与长期稳定认识的统一载体，以稳定 ID 承接后续变化 | [认识笔记](note.md) |
| Weave | 组织相关主题，促进跨来源知识融合，收敛独立处理上下文 | [Weave](weave.md)、[主题树](topic.md) |
| Route | 为输入选择一个话题，无合适归属时使用 Default | [路由](route.md) |
| Topic / Chief | Topic 保存长期认识和主题组织关系，Chief 在 root 综合研判子树输入，直接处理或委托工作 | [主题](topic.md)、[Chief](chief.md) |
| Task / Routine | 有限目标与持续职责的独立生命周期 | [Task](task.md)、[Routine](routine.md) |
| Ongoing | 同一未决事项的进展、下次核实和收尾依据 | [事项跟进](ongoing.md) |
| Person | 人物身份、可选 Me 标记和持续积累的认识 | [人物](person.md) |
| Address | 沟通场合、已知参与者、场合认识与投递目的地 | [场合](address.md) |
| Output | 已决定表达的内容、对象、地址与投递状态 | [输出](output.md) |

Route 的确定性规则直接分派，其余交给持续 Route Agent。各 Agent 通过工具明确确认业务进展，通过 say 创建 Output，投递器负责发送和回执。

Personal 采用 [工具驱动与持续接纳](../harness/README.md#agent-的使用方式与持续职责) 的 Agent 使用方式：Chief 服务于 root Topic 的综合理解与研判，Task Agent 服务于有限目标，Routine Agent 服务于持续职责。Reconcile 负责确定性协调，Agent 负责非确定性判断；新动向通过 followUp / steer 加入运行中的会话，以 assess_input、report_task / report_routine 和 say 分别提交研判、办理进展与沟通。业务完成以这些回执为准，最终文本用于内部执行摘要。

## 角色与协作

Aide 是一个多角色并行系统。Input 经多个角色转换、加工和处理，贡献到 Output 或 Note 中；这些贡献可以是内容的一部分，并不要求一条 Input 对应一个产物。

角色的本质是 Reconciler，通过资源事实协作。Agent 为角色提供智能化执行能力，对外属于 Reconciler 的内部细节。[Secretary](secretary.md) 确定性地准备输入，Chief Reconciler 借助 Agent 完成判断并提交结果。Chief 写入 Input／Batch 的终态结果后，该项处理完成；没有写成终态的条目由后续 Chief 重新处理。后续周期任务新建 Input，Batch 成员同步属于结果投影。

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

## 运行与验证

Personal 的资源定义与 Controller 经普通 Plugin 契约注册；Source、Route、Topic、Task 和 Routine 各自协调资源，Person 共享目录按需读写。Controller 之间通过资源变更与索引协作，依据持久回执判断业务完成状态。

框架机制见 [Plugin](../plugin/README.md)，原生执行边界见 [Harness](../harness/README.md)，外部接入见 [Connector 与 Source](../connector/README.md)。配置阈值集中在 [配置](../configuration.md)，真实模型和平台效果按 [E2E](../e2e.md) 验收。各主题文档链接相应自动测试；替身测试不证明真实提供方连通或模型判断质量。
