# Secretary

## 整体定位

Secretary 是与 Chief 配套的确定性角色，负责把当前材料整理为可处理的待办，像秘书为老板安排工作日程。日程随资源事实变化持续更新，不绑定自然日。它决定何时准备哪些请求，业务判断与执行由 Chief 负责。

角色的本质是 Reconciler。Secretary 运行在 Topic 的具名 `secretary` Controller 中，独立于 Chief 的执行，因此 Chief 忙时仍可准备后续待办。它通过资源读写协作，不调用 Agent、不领取 Chief execution，也没有独立的 Secretary CRD 或会话。

## 输入与产物

| 观察到的事实 | 准备的待办 |
| --- | --- |
| Deferred Input 的数量与最早等待时间达到阈值 | 创建独立 Batch，将兼容的原始 Input 归入固定批次 |
| Topic 的直属未归集 Input、Work 或 child 数量超限 | 创建一条 `aide:organize` Input，请 Chief 一起整理主题结构和材料归属 |
| Weave 结构版本变化或 Note 容量压力 | 创建 `aide:curate` Input，请 Chief 检查并维护认识 |
| Chief 完成量达到阈值，或待回顾活动等待达到时限 | 创建 `aide:curate` Input；本轮覆盖请求创建时的完成水位 |
| 静默检查到期且没有待办 | 只更新检查时间与退避，不创建 Input、不触发 Agent |

每个普通 Topic 检查自己的直属容量；维护请求交给其当前 root Chief 处理。领域 root 负责子树认识维护和业务批次准备。Gate 的单聊与协调请求逐条研判。具体范围见[容量与维护请求](#容量与维护请求)和 [Gate](gate.md)。

## Note 维护

Secretary 合并领域内的梳理需求，并按约定时间为开放 Ongoing 生成 followup。`upsert_ongoing` 保存核实时间，首次缺省为写入后 24 小时。curate 整理普通 Note；followup 只核实未决问题，必要时私下询问 Me。[Note 梳理](note.md#梳理与提炼)、[Ongoing 核实与收尾](ongoing.md#核实与收尾)

### 摘要复核

Secretary 每到整刻钟检查一次，从已有 Summary 或相关普通 Note 的 Topic、Person 和 Address 中选择最久未复核的对象，未复核对象优先。Topic 的责任 root 承接检查；Person 与 Address 由 default Chief 承接。只有该 Chief 当前没有执行、没有排队的 Input 或 Batch，才递交一条 `aide:summary`。忙就跳过当轮，下一个整刻钟照常检查。时钟保存在 Gate，重启只检查当前一轮。

Chief 完成 Input 时同时记录对象的 `summaryReviewedAt`，即使正文保持原样也算完成。Summary 的内容版本只随内容变化。判断标准见 [Note](note.md#事项归位与提炼回顾)。

## Reconciler

资源 Watch 唤醒 Secretary，周期协调补齐漏掉的通知与时间阈值。Secretary 从索引查询当前待办、Batch、Topic 结构和 Note 压力，去重已有请求，取消已过时的未接纳安排，再准备需要的新任务。检查时间、各类维护请求的身份与需求指纹、冷却及退避保存在 Topic 调度状态中。普通 Immediate／Normal Input 直接交给 Chief；Secretary 旁观处理事实，不是所有 Input 的前置关卡。

### Deferred 归组

当前 Batch 仅用于 Deferred Input。Secretary 按 `topic.deferred.count` 与 `maxWaitSeconds` 判断是否归组，保留各成员的来源、原 attention 和权限依据；Batch 按 Normal 优先级交给 Chief。Immediate、Normal、内部维护及显式 handoff 保持独立 Input。

成员归组与 Batch 就绪在同一事务中提交。`Input.status.batchId` 是成员关系的唯一记录，`batchAt` 记录归组时间；Batch 创建并完成归组后，后到材料留待下一批。成员兼容性、准备中断、容量不足与保留规则由 [Batch](batch.md) 定义。

### 容量与维护请求

维护任务使用普通 Input：origin 标记请求类型，text 描述任务，curate 的 `observation.review` 保存请求时的 Chief 完成水位、结构通知版本和压力依据。创建请求时确定 Topic 归属；负责人分派随当前 Topic tree 收敛到 root。

同一 Topic、同一维护 origin 的排队、执行和可重试请求共同参与去重。一轮完成后，后续周期或新变化产生新的 Input；已消失且尚未接纳的请求可取消。完整参数见[配置](../configuration.md#topic-消费策略)。

每个 Topic 的 Secretary Reconcile 检查自己的直属容量，root 与非 root 使用相同机制。直属 Input 移入移出、完成或删除，以及 child 创建、删除和换 parent，会唤醒受影响节点；周期协调兜底。查询按索引读取至阈值加一，最多携带 8 条材料或 child 的标识，不为判断超限读取全部对象。

| origin | 触发与目的 |
| --- | --- |
| aide:organize | 任一直属容量超限时，汇总 Input、Work、child 的计数与样本。所有超限都消失后可取消尚未接纳的议程 |
| aide:followup | 跟进需要回应的事项；按开放 Ongoing 保存的 `checkAt` 一次性调度，核实具体问题或复核事项是否仍需跟进 |
| aide:curate | 普通 Note 的改动达到批量或等待上限，或工作量、子摘要、结构与预算变化需要梳理；核对证据并整理普通 Note |

内置请求复用 Input，status.topic 指向目标节点，未领取时 status.assess.topic 收敛到当前 root，领取后保留实际负责人。origin 决定 Chief 的工具与处理路径，text 描述任务。Secretary 统一准备 Curate／Followup／Organize，每个节点、每种 origin 最多一条未完成请求；可重试失败仍处理原 Input。创建与请求记账原子提交，结果与完成水位原子提交，无需二次结算。`maintenanceRequests` 保留请求身份、时间、需求指纹与尝试次数；同一需求从 `capacityCooldownSeconds`（默认 60 秒）指数退避到 2 小时（基础冷却更长时保留基础冷却），新需求重新安排。已完成 Input 回收后仍可从 Topic 保留的事实继续调度。

maxUnfiledInput 统计直属、无 topicKey、未删除的业务 Input，包含已研判材料；三类内置 Input 排除。maxInput 字段暂时保留，不参与策略。maxChildren 统计直属有效 child。归集到 child 后，该 child 同样检查阈值并请求 root 继续整理；已完成回执不重置。容量触发独立于静默回顾退避，执行前重查需求，已消失则直接完成请求。提示每轮至多处理 8 条材料或直属 child；这是 Agent 执行要求，不是工具调用次数硬配额，整体激活提示还受 contextChars 限制。

### 工作量与时间窗口

`Topic.status.chiefWorkload` 记录 Chief 已完成量与最近 Curate 覆盖的水位。每成功处理一个独立 Input 或 Batch 计一次，包括 Curate、Followup、Organize；Batch 内有多少成员都只计一次，成员结果投影不重复计数。Task／Routine 的执行、状态和报告不计入 Chief 工作量；如果形成了新的协调 Input，并由 Chief 完成，则按一次计数。

默认累计 10 次完成触发 Curate；不足 10 次时，从最早尚未回顾的活动等待 15 分钟触发，后续完成不推迟该时间。Curate 自身仍计入下一轮数量，但不独自开启定时回顾需求，避免空闲时持续自我触发。请求记录创建时的完成水位，完成事务只确认这一水位，并保留请求后到来的活动。计数和时间窗口随 Topic 持久化，不依赖已完成 Input 的保留或历史扫描。

Secretary 根据 Weave 通知、工作量和 Note 本身的变化或容量压力准备维护请求。父子 Summary 独立修订。压力指纹使用材料身份、正文和预算，单纯改名沿用原退避。

无活动、无维护需求时，Secretary 的静默检查默认按 15、30、60、120 分钟退避；资源 Watch 和短周期 tick 仍保障新 Input 与阈值响应。空检查不触发 Agent，新的业务到达恢复检查节奏。

### 协调周期与配置变更

Topic 配置区分 `trigger.intervalSeconds`（默认 60 秒，固定唤醒 Reconcile）和 `review`（业务回顾策略）。单个 Topic 的 `spec.review.enabled` 默认开启；关闭只停止后台回顾，不停止协调、业务输入或结构通知。Chief Harness 不持有业务调度配置。

回顾截止时间从持久化事实与当前策略计算。调整配置后，下一次协调使用新策略，不从重启重新计时、不补跑错过的周期。Chief 执行结束只保存执行事实，不重置 Secretary 调度状态。失败或缺少终态回执时，Chief 重试原 Input／Batch；完成回执不再二次结算。关闭回顾或调整责任边界时，明确重置静默检查状态。

维护 Input 创建即绑定目标 Topic，无需 Route 模型；请求身份、冷却及 Curate 覆盖快照原子保存。Chief 使用 origin 选择工具，通过 `assess_input` 留下结果；系统 Input 不刷新 `lastInputAt`、不新增授权。日志区分请求生成、冷却等待、无事退避与执行结果，保留 origin、Topic、请求身份、触发原因与下一次检查时间。

## 与 Chief 及其它角色协作

Chief Reconcile 关注抽到的非 Deferred Input／Batch，按其 origin、attention 和权限选择工具并触发 Agent，把当前待办处理好。Secretary 关注更多资源事实，它的工作产物是新的 Input 或就绪 Batch。Chief 角色内部使用 Agent 作判断，通过 `assess_input` 提交持久化结果；完成结果、Chief 工作量与本次 Curate 覆盖水位在同一事务中提交。Chief 不决定下一次维护何时发生，也不在执行结束时重置秘书的退避。

Secretary 观察 Chief 已持久化的完成事实，后续需求产生新 Input。结果写入与重试由 [Chief](chief.md#完成与重试) 负责，Batch 成员结果由 Input Reconcile 投影；这些完成路径无需秘书再次确认。

Route 负责初始 Topic 归属，Weave 负责 Topic 之间的组织关系，Task／Routine 负责持续办理。Secretary 以这些角色留下的资源事实准备任务，角色之间不直接触发彼此的 Agent。完整流转见 [Personal](README.md#角色与协作) 和 [Input](input.md#路由研判与办理)。

## 实现入口

- [Secretary Reconcile](../../plugins/personal/secretary/reconcile.ts)：待办准备、空检查与过时请求取消。
- [Batch 准备](../../plugins/personal/secretary/batching.ts)：Deferred 归组与未接纳 Batch 协调。
- [维护请求](../../plugins/personal/secretary/input.ts)与[容量检查](../../plugins/personal/secretary/maintenance.ts)：请求去重、触发证据与准备阶段冷却。
- [Chief 完成事务](../../plugins/personal/chief/assess.ts)与[完成记账](../../plugins/personal/chief/input-outcome.ts)：结果及调度事实原子提交。
- [角色注册](../../plugins/personal/plugin.ts)与[协作测试](../../tests/topic-secretary.test.ts)：并行协调、完成与恢复边界。
