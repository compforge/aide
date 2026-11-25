# Gate：全局信息域与行动范围

Gate Topic / Agent 代表 Aide 的全局信息域和行动范围，目前由 Me 与 Aide 独享。Web `/gate` 汇集双方单聊的对话和跨领域待跟进事项；Me 在群里 @ Aide、其他人的消息以及 Source 观察仍归领域 Topic / Chief。

## 树与责任边界

Gate、领域 root 与子 Topic 表达同一棵 Topic tree 中的结构位置。Gate 是唯一无 `parentRef` 的 Topic，全局单例使用内置 `id=gate` 定位。`isGateTopic(topic)` 判断是否为 Gate，`isRootTopic(topic)` 判断是否为 Gate 的直接子 Topic；业务代码统一使用这两个方法。领域 root（含 Default）的 `parentRef` 指向 Gate；领域内的子 Topic 结构保持不变。首次启动时创建内置 Gate，后续复用其 UID；创建领域 root 时将 parentRef 指向该 Gate。

物理树表达全局信息范围，执行范围止于各领域 root。每个领域 root 配套自己的 Chief，处理本领域及后代；Gate 按原始 inputId 研判单聊和协调请求。多条请求可以在同一次执行中投递，每条各有自己的研判回执。Route、Weave、领域导航、维护和回收使用“领域 root”语义。Weave 可以在 Gate 下归组多个领域 root，知识吸收止于领域 root。

Gate 保留聊天上下文。转交可通过 Input 追溯；当前办理进展按需从负责领域的 Work 和 Output 读取。旧回答是历史上下文，回答变化中的事实时重新读取领域证据。领域 Note 和 Topic / Person / Address summary 是知识归属；Gate 不写 Note、summary，不执行 curate、followup、organize 或 summary，不建立第二套领域认识。

Gate 不被普通删除、容量回收或空闲 session 释放。新建 Gate Task / Routine 在资源校验处拒绝；升级前已接纳的 Gate Work 保留身份与读取范围，允许完成原工作，避免迁移中丢失执行状态。

## 接收与运行

Channel 先确定作者与会话事实，Personal 决定路由。Web 是本机 Me 的单聊入口；Lark 必须同时满足 Channel 接纳、发送者与配置的 Me 匹配、`chatType=p2p`。Me 在群里 @ Aide 不满足单聊条件。Source 观察和仅有 `relation=sent` 的输入不会进入 Gate。

单聊规则先于 `topicKey` / `topicId`：从领域 Web 页面发来的消息也归 Gate，所选 Topic 仅是上下文提示。页面提交后进入 Gate 查看回答。消息保留原 Address 和回复坐标，跨渠道共享连续性不改变投递目的地。

Gate 使用独立 `plugins/personal/gate/agent/`、`gate` Harness、提示词、工具及 `gate:<Topic UID>` 原生 session scope，不组合 Chief Agent。双方复用 Pi、Harness 执行、Input 接纳和会话恢复底座。`harnesses.gate.model` 可独立配置，缺省复用 Chief 的已解析模型；`harnesses.gate.packages` 独立配置，通过 `aide harness sync gate` 安装。

## 查询与交办

每次请求加载 Me 和当前接纳的 Input，按需检索相关领域，不常驻整棵树的正文。查询通常按“Topic → summary 与 Note 目录 → read_note / Work → 原始 Input”展开。引用 Note 保留 UID、版本和分类，预览截断时补读全文。

| 角色与工具 | 职责 |
| --- | --- |
| Gate：list_topics / read_topic、list_notes / read_note | 全局检索领域认识，返回来源链接 |
| Gate：list_inputs / read_input、list_work / read_work | 追溯证据，查询 Task、Routine 或 Ongoing 的进展，按需把 Me 的新信息交回负责领域 |
| Gate：append_input | 将 Me 的原始请求或补充转给负责的领域 root，返回转交 Input 的 ID |
| 领域 Chief、Task、Routine：say | 按需使用 respondToInputId 向原单聊地址答复 |

转交生成普通业务 Input，来源为 `aide:handoff`，保留原始 Input 引用、原文、地址、发送者与回复坐标。同一条用户 Input 转给同一领域时复用投递标识。Chief 结合已有认识研判，当轮答复或建立、更新 Work。Gate 对话按 Output 的 conversation 关联展示领域答复。投递、Work 进度与 Output 送达分别读取对应资源。

Web Gate 的「跟进」分页展示各 Topic 尚未关闭的 Ongoing。近期转交记录可在 Inputs 按来源筛选。

## 验证

- `tests/gate-handoff.test.ts` 验证转交去重、补充请求与定向回复。
- `tests/pi-agent.test.ts` 的 Gate 场景：真实 Pi SDK 与本地脚本模型驱动 Gate 查询、领域交办、Chief 创建 Task、回报和重启恢复。验证协议及业务链路，不证明真实模型的回答质量。
