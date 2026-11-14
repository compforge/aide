# Gate：全局信息域与行动范围

Gate Topic / Agent 代表 Aide 的全局信息域和行动范围，目前由 Me 与 Aide 独享。Web `/gate` 汇集双方单聊的对话和交办记录；Me 在群里 @ Aide、其他人的消息以及 Source 观察仍归领域 Topic / Chief。

## 树与责任边界

Gate 是唯一 `id=gate`、`spec.gate=true`、无 `parentRef` 的全局根。领域 root（含 Default）的 `parentRef` 指向 Gate；领域内的子 Topic 结构保持不变。系统创建领域 root 时补齐 Gate 父引用，启动时迁移旧的无父领域 root，保留 UID、Note、Work、session 和处理回执。

物理树表达全局信息范围，执行范围止于各领域 root。每个领域 root 配套自己的 Chief，处理本领域及后代；Gate 的处理队列只消费 Gate Input。Route、Weave、领域导航、维护和回收使用“领域 root”语义。Weave 可以在 Gate 下归组多个领域 root，知识吸收止于领域 root。

Gate 持有聊天、请求、决定、交办引用和进展，原生会话及压缩保持对话连续性。旧回答是历史上下文，回答变化中的事实时重新读取领域证据。领域 Note 和 Topic / Person / Address summary 是知识归属；Gate 不写 Note、summary，不运行 review、triage、organize，不建立第二套领域认识。

Gate 不被普通删除、容量回收或空闲 session 释放。新建 Gate Task / Routine 在资源校验处拒绝；升级前已接纳的 Gate Work 保留身份与读取范围，允许完成原工作，避免迁移中丢失执行状态。

## 接收与运行

Channel 先确定作者与会话事实，Personal 决定路由。Web 是本机 Me 的单聊入口；Lark 必须同时满足 Channel 接纳、发送者与配置的 Me 匹配、`chatType=p2p`。Me 在群里 @ Aide 不满足单聊条件。Source 观察和仅有 `relation=sent` 的输入不会进入 Gate。

单聊规则先于 `topicKey` / `topicId`：从领域 Web 页面发来的消息也归 Gate，所选 Topic 仅是上下文提示。页面提交后进入 Gate 查看回答。消息保留原 Address 和回复坐标，跨渠道共享连续性不改变投递目的地。

Gate 使用独立 `agents/gate/`、`gate` Harness、提示词、工具及 `gate:<Topic UID>` 原生 session scope，不组合 Chief Agent。双方复用 Pi、Harness 执行、Input 接纳和会话恢复底座。`harnesses.gate.model` 可独立配置，缺省复用 Chief 的已解析模型；`harnesses.gate.packages` 独立配置，通过 `aide harness sync gate` 安装。

## 查询与交办

每次请求加载 Me、当前接纳的 Input 和有界交办背景，按需检索相关领域，不常驻整棵树的正文。查询通常按“Topic → summary → 近期 Note / Work → 原始 Input”展开。引用 Note 保留 UID、版本和分类，预览截断时补读全文。

| 角色与工具 | 职责 |
| --- | --- |
| Gate：list_topics / read_topic、list_notes / read_note | 全局检索领域认识，返回来源链接 |
| Gate：list_inputs / read_input、list_work / read_work | 追溯证据和工作进展；读取不改变领域执行状态 |
| Gate：delegate_request | 将原始 Me 请求交给一个负责领域；未确定领域时交由 Route / Default 选择 |
| Gate：followup_request | 将 Me 的新回答、补充或变更交给原交办，保留同一责任关系 |
| Gate：list_handoffs / read_handoff | 分页读取请求、接手、执行进展和关联 Work |
| Gate：assess_input、cite_output / say | 确认本次输入处理，引用证据并答复原单聊 |
| Chief / Task / Routine：read_handoff / report_handoff | 读取原请求、报告业务进展；有明确协调需要时请求 Gate 介入 |

简单询问和跨域比较由 Gate 直接回答。需要具体行动、持续跟进或更新领域认识时交给负责的 root Chief，由它选择直接处理、已有 Work、新 Task 或 Routine。交办前查询已有关系和工作，避免重复。跨领域事情明确牵头领域和各自有界的贡献，Gate 负责协调。

`Handoff` 是独立的持久交办关系，保存原 Input 引用和正文、请求、Gate、领域、回复地址、最新委托 Input、进展及 Work 引用。交办和领域 Input 在同一事务中接纳；同一原 Input 和目标幂等。追问沿同一 Handoff 增加序号，旧序号的报告不能覆盖新请求。领域短期 Input 过期不删除交办关系。

## 回复、状态与循环控制

Chief / Work 使用 `say(respondToHandoffId=交办ID)`（也可在 Input 保留期内使用 `respondToInputId`） 沿原单聊 Address、消息坐标和收件人答复。Output 同时关联 Gate conversation 与 Handoff，Web Gate 历史直接展示领域回复，不强制改投 Web，也不需要 Gate 再调用模型改写一遍。

`assess_input` 表示已研判输入；Handoff 的 `submitted / accepted / working / waiting / completed / failed` 表示交办进展；Output 的投递状态表示送达事实。这三者独立，不能从“已经接纳”推断业务完成或送达。Task / Routine 仍须报告自己的生命周期。

普通 Output 和报告不会唤醒 Gate。只有 `report_handoff(coordinate=true)` 产生一次幂等的协调 Input；协调通知不是新的 Me 授权，不能通过 delegate / followup 自动递归交办。Gate 不循环等待工作完成。

## 验证

- `tests/gate.test.ts`：持久入口、流式回复、幂等、恢复、领域读取与执行隔离。
- `tests/gate-handoff.test.ts`：Me 单聊与群 @ 区分，原地址回复、交办幂等、追问、过时/跨领域报告、协调去重及旧根迁移。
- `tests/pi-agent.test.ts` 的 Gate 场景：真实 Pi SDK 与本地脚本模型驱动 Gate 查询、领域交办、Chief 创建 Task、回报和重启恢复。验证协议及业务链路，不证明真实模型的回答质量。
