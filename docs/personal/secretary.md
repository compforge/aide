# Secretary

## 整体定位

Secretary 是与 Chief 配套的确定性角色，负责把当前材料整理为可处理的待办，像秘书为老板安排工作日程。日程随资源事实变化持续更新，不绑定自然日。它决定何时准备哪些请求，业务判断与执行由 Chief 负责。

Secretary 通过资源 Watch 和定时协调工作。独立的 secretary Controller 负责 Deferred 归组和压力观测，领域 agent Controller 在同一 root 的串行执行边界内调用秘书选单并接纳结果。

## 输入与产物

| 观察到的事实 | 准备的待办 |
| --- | --- |
| 同组 Deferred Input 达到数量阈值，或最早一条等到时限 | 创建独立 Batch，将兼容的原始 Input 归入固定批次 |
| Topic 的直属未归集 Input、Work 或 child 数量超限 | 创建一条 `aide:organize` Input，请 Chief 一起整理主题结构和材料归属 |
| Weave 结构版本变化或 Note 容量压力 | 创建 `aide:curate` Input，请 Chief 检查并维护认识 |
| Chief 完成量达到阈值，或待回顾活动等待达到时限 | 创建 `aide:curate` Input；本轮覆盖请求创建时的完成水位 |
| 静默检查到期且没有待办 | 只更新检查时间与退避，不创建 Input、不触发 Agent |

每个普通 Topic 检查自己的直属容量；维护请求交给其当前 root Chief 处理。领域 root 负责子树认识维护和业务批次准备。Gate 的单聊与协调请求逐条研判。具体范围见[容量与维护请求](#容量与维护请求)和 [Gate](gate.md)。

## 领域静默

领域根 Topic 的 `status.phase` 取 `active` 或 `dormant`，覆盖整棵职责树。Channel、Source 和 Gate 转交的用户请求按原始到达时间更新 `lastInputAt`。用户主动补充 Ongoing 也算外部活动。秘书的内部 Input 和 Chief 的办理决定保持现有活动时间。

距最后一次外部活动满 `topic.dormantAfterSeconds`（默认 900 秒），Chief 执行结束且业务清空后，领域可以静默。秘书可在此之前安排最后一批 Note 整理。静默暂停 Curate、Organize、Summary，已承诺的 Ongoing 仍按计划跟进。

外部 Input 唤醒领域后，在下一次 Chief prompt 前评估一次当前 Pi session 的上下文。达到 `topic.wakeCompactTokens`（默认 128000）时，Pi 生成历史摘要并按其近期消息预算保留原文。Chief 可按 ID 回读仍在职责树内的 Input。压缩使用现有 Usage 记录，失败时记录原因并继续处理原请求。进入静默本身不调用模型、不释放 session；长期空闲的 session 沿用原有回收策略。

## Note 维护

Secretary 合并领域内的梳理需求，并在开放 Ongoing 到期或收到新关联材料时递交 followup。Chief 创建 Ongoing 时保存核实时间，缺省为 1 小时后，之后可以通过 upsert_work 调整。curate 结合普通 Note、已有 Work 和后续证据复盘该领域的认识与责任。followup 围绕指定 Ongoing 核实未决问题，必要时私下询问 Me。[Note 梳理](note.md#梳理与提炼)、[Ongoing 核实与收尾](work.md#核实与收尾)

### 摘要复核

Secretary 每到整刻钟检查一次，从已有 Summary 或相关普通 Note 的 Topic、Person 和 Address 中选择最久未复核的对象，未复核对象优先。Topic 的责任 root 承接检查；Person 与 Address 由 default Chief 承接。只有该 Chief 当前没有执行、没有排队的 Input 或 Batch，才递交一条 `aide:summary`。忙就跳过当轮，下一个整刻钟照常检查。时钟保存在 Gate，重启只检查当前一轮。

Summary 请求投递时记录对象的轮转时间 `summaryReviewedAt`；正文修订由 Note 的实际变更记录。Summary 的内容版本只随内容变化。判断标准见 [Note](note.md#事项归位与提炼回顾)。

## Reconciler

资源变更、定时到期以及 root 清除 status.execution 都能触发协调。秘书重读该 root，忙时只做备料。空闲时先选一条就绪业务 Input 或一个 Batch，再检查到期或有新材料的 Ongoing、待整理的 Note 和领域结构。到达复核时刻时，Summary 也可作为本轮工作。选中内部工作后才创建 Input，由该 root 的 Chief 接纳。

### Deferred 归组

Deferred Input 按兼容条件归组。无论 Chief 忙闲，达到 `topic.deferred.count` 或最早一条等到 `maxWaitSeconds` 即可封批。封批前材料保留在原 Input，封批事务固定成员。已封好的 Batch 等 Chief 空闲后作为一项工作投递，晚到的材料归下一批。

成员归组与 Batch 就绪在同一事务中提交。`Input.status.batchId` 是成员关系的唯一记录，`batchAt` 记录归组时间；Batch 创建并完成归组后，后到材料留待下一批。成员兼容性、准备中断、容量不足与保留规则由 [Batch](input.md#batch) 定义。

### 容量与维护请求

维护任务使用普通 Input：origin 标记请求类型，text 描述任务，curate 的 `observation.review` 保存请求时的 Chief 完成水位、结构通知版本和压力依据。创建请求时确定 Topic 归属；负责人分派随当前 Topic tree 收敛到 root。

已选中的 Input 保留稳定身份，投递失败按原回执恢复。尚未选中的需求继续由 Ongoing、Note 和 Topic 表达。

Secretary 在领域 root 选单时检查子树各 Topic 的直属容量。直属 Input 移入移出、完成或删除，以及 child 创建、删除和换 parent，会唤醒受影响节点；周期协调兜底。查询按索引读取至阈值加一，最多携带 8 条材料或 child 的标识，不为判断超限读取全部对象。

| origin | 触发与目的 |
| --- | --- |
| aide:organize | 直属容量超限时，汇总本次待整理的 Input、Work 和 child |
| aide:followup | 开放 Ongoing 到期或收到新材料时核实现状。到期检查投递成功后，默认一小时后再次检查 |
| aide:curate | 普通 Note 的改动达到批量或等待上限，或工作量、子摘要、结构与预算变化需要梳理；Chief 据此核对普通 Note 和相关 Task、Routine、Ongoing |

内置 Input 的 origin 决定工具范围，status.topic 指向目标节点。普通 Note 依据 curateAt 和已投递内容选择，组织压力和回顾压力依据 maintenanceChecks 中的检查时间、证据指纹和尝试次数限频。相同压力最多退避到两小时。

maxUnfiledInput 统计直属、无 topicKey、未删除的业务 Input，包含已研判材料；三类内置 Input 排除。maxInput 字段暂时保留，不参与策略。maxChildren 统计直属有效 child。归集到 child 后，该 child 同样检查阈值并请求 root 继续整理；已完成回执不重置。容量触发独立于静默回顾退避，需求在选单前消失时，本轮跳过。提示每轮至多处理 8 条材料或直属 child；这是 Agent 执行要求，不是工具调用次数硬配额，整体激活提示还受 contextChars 限制。

### 工作量与时间窗口

`Topic.status.chiefWorkload` 记录 Chief 已完成量与最近 Curate 覆盖的水位。每成功处理一个独立 Input 或 Batch 计一次，包括 Curate、Followup、Organize；Batch 内有多少成员都只计一次，成员结果投影不重复计数。Task／Routine 的执行、状态和报告不计入 Chief 工作量；如果形成了新的协调 Input，并由 Chief 完成，则按一次计数。

默认累计 10 次完成触发 Curate；不足 10 次时，从最早尚未回顾的活动等待 15 分钟触发，后续完成不推迟该时间。Curate 自身仍计入下一轮数量，但不独自开启定时回顾需求，避免空闲时持续自我触发。请求记录创建时的完成水位，完成事务只确认这一水位，并保留请求后到来的活动。计数和时间窗口随 Topic 持久化，不依赖已完成 Input 的保留或历史扫描。

Secretary 根据 Weave 通知、工作量和 Note 本身的变化或容量压力准备维护请求。父子 Summary 独立修订。压力指纹使用材料身份、正文和预算，单纯改名沿用原退避。

领域仍活跃且没有维护需求时，Secretary 的回顾检查默认按 15、30、60、120 分钟退避；资源 Watch 和短周期 tick 仍保障新 Input 与阈值响应。空检查不触发 Agent，新的业务到达恢复检查节奏。

### 协调周期与配置变更

Topic 配置区分 `trigger.intervalSeconds`（默认 60 秒，固定唤醒 Reconcile）和 `review`（业务回顾策略）。单个 Topic 的 `spec.review.enabled` 默认开启；关闭只停止后台回顾，不停止协调、业务输入或结构通知。Chief Harness 不持有业务调度配置。

回顾截止时间从持久化事实与当前策略计算。调整配置后，下一次协调使用新策略，不从重启重新计时、不补跑错过的周期。Chief 执行结束只保存执行事实，不重置 Secretary 调度状态。明确未投递的 Input／Batch 可以再次调度。执行中断时先核对原生会话，结果不明的投递留待核实。关闭回顾或调整责任边界时，明确重置静默检查状态。

维护 Input 创建即绑定目标 Topic，无需 Route 模型；请求身份、冷却及 Curate 覆盖快照原子保存。Chief 使用 origin 选择工具，按需执行相应操作；系统 Input 不刷新 `lastInputAt`、不新增授权。日志区分请求生成、冷却等待、无事退避与执行结果，保留 origin、Topic、请求身份、触发原因与下一次检查时间。

## 与 Chief 及其它角色协作

秘书负责选单，Chief 按本轮 Input 的 origin 和授权范围办理。运行时同时提交投递回执、Chief 工作量与对应维护水位。

Secretary 观察 Chief 已持久化的完成事实，后续需求产生新 Input。结果写入与重试由 [Chief](chief.md#完成与重试) 负责，Batch 成员结果由 Input Reconcile 投影；这些完成路径无需秘书再次确认。

Route 负责初始 Topic 归属，Weave 负责 Topic 之间的组织关系，Task／Routine 负责持续办理。Secretary 以这些角色留下的资源事实准备任务，角色之间不直接触发彼此的 Agent。完整流转见 [Personal](README.md#角色与协作) 和 [Input](input.md#路由投递与办理)。

## 实现入口

- [Secretary Reconcile](../../plugins/personal/secretary/reconcile.ts) 汇集 root 当前候选并选出一项。
- [Batch 准备](../../plugins/personal/secretary/batching.ts)：Deferred 归组与未接纳 Batch 协调。
- [维护请求](../../plugins/personal/secretary/input.ts)与[容量检查](../../plugins/personal/secretary/maintenance.ts)：请求去重、触发证据与准备阶段冷却。
- [Chief 投递事务](../../plugins/personal/chief/delivery.ts)同时提交投递回执和[工作量记录](../../plugins/personal/chief/input-outcome.ts)。
- [角色注册](../../plugins/personal/plugin.ts)与[协作测试](../../tests/topic-secretary.test.ts)：并行协调、完成与恢复边界。
