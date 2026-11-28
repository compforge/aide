# Secretary：为领域 Chief 选择下一件工作

## 职责与一轮调度

每棵领域 Topic 树由 root 的 Chief 负责。秘书观察树里的 Input、Batch、Note 和 Work，在 Chief 能接单时，按当前事实选一件交给它。Chief 读取材料，判断要不要回复、推进工作或整理认识。Gate 有自己的对话投递方式。[Chief 的接纳与连续执行](chief.md#接纳与连续执行) · [Gate](gate.md)

<a id="reconciler"></a>

1. **唤醒。** 资源变化、定时到期，或 root Topic 清除本轮执行状态，都会让秘书重新检查。
2. **看闲忙。** 秘书重读 root 的 `status.execution`。已有执行时，Chief 继续手头的事，秘书可以独立封批、更新 Note 的容量信息。
3. **选一件。** Chief 空闲时，秘书先看已经就绪的 Input 和 Batch，再检查 Ongoing 和领域维护需求。选中一个内部事项时，才根据当前材料创建对应的 Input。本轮没有合适的工作，就等下次唤醒。

例如，Chief 正在处理别的事，一条跟进交付的 Ongoing 到了 `nextCheckAt`。这时用户又发来一条普通 Input：“对方已经确认收货。”下轮秘书先递交这条消息。Chief 据此记录结论并关闭 Ongoing。再下一轮，秘书看到事项已关闭，这次到期检查就无需生成 `aide:followup`。[对应的调度用例](../../tests/topic-secretary.test.ts)

## Deferred 归组

Chief 忙时，秘书仍可为它准备下一批材料。兼容的 Deferred Input 达到数量阈值，或同组最早一条等到时限，秘书就封一个 Batch。默认是 **10 条或 10 分钟**。即使只有一条也能按时封批，后来到达的 Input 不会推迟最早一条的期限。

封批固定本批成员，晚到的材料归入下一批。就绪的 Batch 保存在 CRD 中，等 Chief 空闲后与其他就绪事项一起参与选择。成员兼容条件、原子归组和恢复规则见 [Batch](input.md#batch)。

<a id="容量与维护请求"></a>

## Chief 空闲时如何选单

秘书在同一 root 内按下表从上往下检查，选到一件便结束本轮。尚未选中的维护需求仍由相应的 Ongoing、Note 或 Topic 表达，下一轮重新判断。

| 观察对象 | 何时可以选 | 交给 Chief 的工作 |
| --- | --- | --- |
| 已就绪的 Input 或 Batch | 有可投递的材料，或已明确投递失败的材料到了重试时间。Immediate Input 优先，其次是可投递的 Batch，再是其他就绪 Input | 一条原 Input 或一个已封的 Batch |
| 开放的 Ongoing | 已到核实时间，或收到尚待处理的关联材料 | `aide:followup`，带事项及相关材料，由 Chief 核实现状、决定下一步。[核实与收尾](work.md#核实与收尾) |
| 有变化的普通 Note | 待整理材料达到批量或最早等待时限；领域进入静默前也可以做一次收尾整理 | `aide:curate`，从这批 Note 出发整理，并核对相关 Work。[Note 梳理](note.md#梳理与提炼) |
| 子树中各 Topic 的直属材料 | 某个 Topic 的未归集 Input、受托 Work 或直属子 Topic 数量超限 | `aide:organize`，带上超限的 Topic 和材料，请 Chief 调整归属 |
| 整个领域的认识 | Chief 的工作量达到回顾条件、Weave 通知结构变化，或 Note 数量与篇幅需要整理 | `aide:curate`，带本轮回顾依据，请 Chief 结合已有 Note 和 Work 重新梳理 |
| Topic、Person 或 Address 的摘要 | 到了全局复核时刻，轮到的对象有相关材料，且负责的 Chief 空闲、没有排队工作 | `aide:summary`，复核这个对象下次被读到时应提供的默认背景，按需修订。[Summary Note](note.md#作为-summary-的-note) |

### 工作量与时间窗口

一次成功投递的独立 Input 或 Batch 给 Chief 记一次工作量。默认累计 **10 次**，或最早一项尚未回顾的活动已等 **15 分钟**，秘书就可以安排一次 Curate。请求只覆盖选中时的完成水位，此后的活动留给下轮回顾。一次 Curate 自身计入完成量，单靠它不会启动下一次定时回顾。

秘书按持久化的活动时间和当前配置计算下次检查。连续几次没有回顾需求时，可以拉长检查间隔；新的外部 Input 仍能通过资源变化及时唤醒秘书。同一容量问题重复出现时也有冷却时间。配置开关、阈值与退避策略见 [Topic 定时协调与回顾](../configuration.md#topic-定时协调与回顾)。

### 摘要复核

Gate 保存全局的 15 分钟时钟。每到整刻钟，优先选有 Summary 或相关普通 Note、且尚未复核的对象，其次选最久未复核的对象。Topic 交给当前领域的 root Chief，Person 和 Address 交给默认领域的 Chief。负责的 Chief 忙或有待办时，跳过本次，下个整刻钟重新选择。复核完成可以保留原文。[摘要复核实现](../../plugins/personal/secretary/summary.ts)

## 一轮结束与领域静默

材料成功进入 Chief 上下文时，运行时记录投递回执；Chief 结束整轮执行时，root 才清除 `status.execution`。前者确认这件材料已经送达，后者唤醒秘书选择下一件。因此，即便材料已经送达，Chief 仍然可能在使用工具处理它。投递结果不明确时，沿用原记录核实。[Chief 的完成与重试](chief.md#完成与重试)

### 领域静默

**空闲**描述 Chief 此刻能否接单，**静默**描述整棵领域树是否还需要例行维护。外部活动停止默认 15 分钟、业务待办清空且 Chief 空闲后，秘书可为本段活动安排最后一批 Note 整理，然后让 root 进入 `dormant`。静默期间暂停 Curate、Organize 和 Summary，已承诺的 Ongoing 仍按计划跟进。

新的外部 Input 会唤醒领域，包括用户主动补充的 Ongoing 信息。内部维护 Input 保留原有的外部活动时间。唤醒后，Chief 在处理新材料前按上下文用量决定是否压缩会话。[Chief 的上下文组织](chief.md#上下文组织与优化) · [唤醒时的会话处理](../../plugins/personal/chief/agent/wake.ts)
