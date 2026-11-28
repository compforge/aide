# Secretary：为领域 Chief 选择下一件工作

## 职责与一轮调度

每棵领域 Topic 树由 root 的 Chief 负责。秘书观察树里的 Input、Batch、Note 和 Work，在 Chief 能接单时，按当前事实选一件交给它。Chief 读取材料，判断要不要回复、推进工作或整理认识。Gate 有自己的对话投递方式。[Chief 的接纳与连续执行](chief.md#接纳与连续执行) · [Gate](gate.md)

<a id="reconciler"></a>

1. **唤醒。** 资源变化、定时到期，或 root Topic 清除本轮执行状态，都会让秘书重新检查。
2. **看闲忙。** 秘书重读 root 的 `status.execution`。已有执行时，Chief 继续手头的事，秘书可以独立封批、更新 Note 的容量信息。
3. **列出候选。** 在工作窗口内，秘书根据各项规则观察事件、条件和经过的时间，给满足规则的内部事项指定 Attention 和等待起点。
4. **选择并投递。** Chief 空闲时，待投递 Input、就绪 Batch 和内部候选按同一顺序选单。已有 Input 或 Batch 直接复用；选中的内部候选才创建 Input、登记本轮材料并投递。其余需求留在原资源上，下次按最新事实判断。

外部业务 Input 到达已有运行中的 Chief 时可以直接投递。Immediate 使用 `steer`，High 和 Normal 使用 `followUp`。例如，用户确认已经收货，Chief 可据此关闭 Ongoing。秘书下次查看这个事项时，已经无需为它生成跟进 Input。

## Deferred 归组

Chief 忙时，秘书仍可为它准备下一批材料。兼容的 Deferred Input 达到数量阈值，或同组最早一条等到时限，秘书就封一个 Batch。默认是 **10 条或 10 分钟**。即使只有一条也能按时封批，后来到达的 Input 不会推迟最早一条的期限。

封批固定本批成员，晚到的材料归入下一批。就绪的 Batch 保存在 CRD 中，等 Chief 空闲后与其他就绪事项一起参与选择。成员兼容条件、原子归组和恢复规则见 [Batch](input.md#batch)。

<a id="容量与维护请求"></a>

## Chief 空闲时如何选单

先比较 **Immediate > High > Normal > Deferred**，同档取较早者。已存在的 Input 和 Batch 使用各自的创建时间。内部候选使用本轮需求的起点，下表给出默认规则。High 的等待时间直接从需求起点计算，首次检查时就可能满足。冷却、已投递记录和工作窗口仍决定候选资格。

| 内部 Input | 事件或条件 | 时间与 Attention |
| --- | --- | --- |
| `aide:curate` | 8 条待整理 Note、10 次待回顾工作量、Weave 结构变化或 Note 容量压力均可触发 Normal | 零散 Note 或工作量等满 15 分钟也可触发 Normal。需求满对应时间阈值的两倍升 High，默认 30 分钟 |
| `aide:organize` | Topic 的直属未归集 Input、受托 Work 或子 Topic 数量超限时为 Normal | 从首次观察到持续超限开始计时，默认满 30 分钟为 High |
| `aide:summary` | 全局每 15 分钟检查有摘要或普通 Note 的 Topic、Person、Address | 到复核时刻为 Normal，从本轮复核计时起点满 30 分钟为 High |
| `aide:followup` | 开放的 Ongoing 收到补充材料，或到了 `nextCheckAt` | Normal，等待起点取到期时间与材料挂入时间中较早的一项 |
| `aide:stow` | 当前 Chief 会话实测 prompt 严格超过 `stowPromptTokens` | Normal，以本轮首次超阈值为起点，与其他 Normal 按时间排序 |

### 工作量与时间窗口

业务 Input、整理与跟进 Input 或一个 Batch 成功投递后，各计一次 Chief 工作量。默认累计 **10 次**，或最早一项尚未回顾的活动已等 **15 分钟**，秘书就可以安排一次 Curate。请求只覆盖选中时的完成水位，此后的活动留给下轮回顾。一次 Curate 自身计入完成量，单靠它不会启动下一次定时回顾。

秘书按持久化的活动时间和当前配置计算下次检查。连续几次没有回顾需求时，可以拉长检查间隔；新的外部 Input 仍能通过资源变化及时唤醒秘书。同一容量问题重复出现时也有冷却时间。配置开关、阈值与退避策略见 [Topic 定时协调与回顾](../configuration.md#topic-定时协调与回顾)。

### 摘要复核

Gate 保存全局的 15 分钟时钟。每到整刻钟，优先选有 Summary 或相关普通 Note、且尚未复核的对象，其次选最久未复核的对象。Topic 交给当前领域的 root Chief，Person 和 Address 交给默认领域的 Chief。Chief 忙或其他候选胜出时保留本轮复核机会。派单成功或检查确无对象，Gate 才推进时钟。复核完成可以保留原文。[摘要复核实现](../../plugins/personal/secretary/summary.ts)

## 一轮结束与工作窗口

材料成功进入 Chief 上下文时，运行时记录投递回执；Chief 结束整轮执行时，root 才清除 `status.execution`。前者确认这件材料已经送达，后者唤醒秘书选择下一件。因此，即便材料已经送达，Chief 仍然可能在使用工具处理它。投递结果不明确时，沿用原记录核实。[Chief 的完成与重试](chief.md#完成与重试)

### 工作窗口

每棵领域树的工作窗口从 root 最近一次外部 Input 的到达时间（`status.lastInputAt`）起持续 30 分钟。Channel、Source、Gate 转交和用户对 Ongoing 的补充都属于外部活动。内部 Input 保留原来的活动时间。领域从未收到外部 Input 时，窗口关闭。

窗口内，各类内部工作按自身条件参与选单。窗口外，秘书继续封批和投递就绪业务，暂停新派内部 Input。Ongoing 的预约即使已到期，也留到下次外部 Input 到来后再判断。已经开始的执行继续完成，窗口结束本身不会派单。

### Stow

`status.agent.promptTokens` 是当前 Chief session 最近一次普通模型调用的完整输入 token 数，包含缓存读写。默认严格超过 128,000 时，Stow 具备触发条件。它以 Normal 与其他候选共同参选。同一窗口可以有多个空档，每份实测值最多派一次。

运行时接到 Stow 后核对工作窗口、session、预留该观测的 Input 与当前读数，直接调用 Pi compact。Stow 的压缩用量归入 Usage 的辅助调用；投递 Stow 不增加 Curate 工作量。失败保留原读数与此次尝试记录；新的普通调用提供新的观测，压缩成功和会话更换清除旧读数。[Stow 选单](../../plugins/personal/secretary/stow.ts) · [Chief 会话](../../plugins/personal/chief/agent/session.ts)
