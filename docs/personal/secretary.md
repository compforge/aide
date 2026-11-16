# Secretary

## 整体定位

Secretary 是与 Chief 配套的确定性角色，负责把当前材料整理为可处理的待办，像秘书为老板安排工作日程。日程随资源事实变化持续更新，不绑定自然日。它决定何时准备哪些请求，业务判断与执行由 Chief 负责。

角色的本质是 Reconciler。Secretary 运行在 Topic 的具名 `secretary` Controller 中，独立于 Chief 的执行，因此 Chief 忙时仍可准备后续待办。它通过资源读写协作，不调用 Agent、不领取 Chief execution，也没有独立的 Secretary CRD 或会话。

## 输入与产物

| 观察到的事实 | 准备的待办 |
| --- | --- |
| Deferred Input 的数量与最早等待时间达到阈值 | 创建独立 Batch，将兼容的原始 Input 归入固定批次 |
| Topic 的直属 Input／Work 数量超限 | 创建 `aide:triage` Input，请 Chief 整理材料归属 |
| Topic 的直属 child 数量超限 | 创建 `aide:organize` Input，请 Chief 整理主题结构 |
| 子认识待吸收、Weave 结构版本变化或 Note 容量压力 | 创建 `aide:review` Input，请 Chief 检查并维护认识 |
| 静默回顾到期 | 检查当前材料；存在维护需求时创建 review Input，否则只更新检查时间与退避 |

每个普通 Topic 检查自己的直属容量；维护请求交给其当前 root Chief 处理。root 负责子树认识维护和业务批次准备。Gate 只参与业务批次准备，不产生知识维护或静默回顾请求。具体范围见 [Topic](topic.md#树内整理与维护优先级) 和 [Gate](gate.md)。

## Reconciler

资源 Watch 唤醒 Secretary，周期协调补齐漏掉的通知与时间阈值。Secretary 从索引查询当前待办、Batch、Topic 结构和 Note 压力，去重已有请求，取消已过时的未接纳安排，再准备需要的新任务。检查时间、容量冷却与空检查退避保存在 Topic 调度状态中。

### Deferred 归组

当前 Batch 仅用于 Deferred Input。Secretary 按 `topic.deferred.count` 与 `maxWaitSeconds` 判断是否归组，保留各成员的来源、原 attention 和权限依据；Batch 按 Normal 优先级交给 Chief。Immediate、Normal、内部维护及显式 handoff 保持独立 Input。

成员归组与 Batch 就绪在同一事务中提交。`Input.status.batchId` 是成员关系的唯一记录，`batchAt` 记录归组时间；Batch 创建并完成归组后，后到材料留待下一批。成员兼容性、准备中断、容量不足与保留规则由 [Batch](batch.md) 定义。

### 维护请求

维护任务使用普通 Input：origin 标记请求类型，text 描述任务，review 的 `observation.review` 保存本次触发所依据的最小版本信息。创建请求时确定 Topic 归属；负责人分派随当前 Topic tree 收敛到 root。

同一 Topic、同一维护 origin 的排队、执行和可重试请求共同参与去重。未完成的请求继续处理原 Input；一轮完成后，后续周期或新变化产生新的 Input。请求创建与准备阶段的冷却状态原子提交。回顾间隔、容量阈值与退避策略见 [Topic 定时回顾](topic.md#topic-定时回顾) 和[配置](../configuration.md)。

## 与 Chief 及其它角色协作

Secretary 写入就绪的 Input／Batch 后，由 Chief 的接纳与执行路径处理。Chief 角色内部使用 Agent 作判断，通过 `assess_input` 或 `assess_batch` 提交持久化结果；维护 Input 的完成结果与相关版本水位、压力和退避记账在同一事务中提交。

Chief 成功写入终态结果，该项处理即完成；写入失败或执行结束仍无终态结果时，释放占用并等待重试。Secretary 不再为处理结果增加一次完成确认。Batch 的终态由 Input Reconcile 投影到成员，回填失败只重试投影；Work 办理与 Output 投递继续遵循各自的完成契约。

Route 负责初始 Topic 归属，Weave 负责 Topic 之间的组织关系，Task／Routine 负责持续办理。Secretary 以这些角色留下的资源事实准备任务，角色之间不直接触发彼此的 Agent。完整流转见 [Personal](README.md#角色与协作) 和 [Input](input.md#路由研判与办理)。

## 实现入口

- [Secretary Reconcile](../../plugins/personal/topic/secretary.ts)：待办准备、空检查与过时请求取消。
- [Batch 准备](../../plugins/personal/batch/reconcile.ts)：Deferred 归组与未接纳 Batch 协调。
- [维护请求](../../plugins/personal/topic/review.ts)与[容量检查](../../plugins/personal/topic/maintenance.ts)：请求去重、触发证据与准备阶段冷却。
- [Chief 完成事务](../../plugins/personal/topic/assess.ts)与[维护记账](../../plugins/personal/topic/review-outcome.ts)：结果及调度事实原子提交。
- [角色注册](../../plugins/personal/topic/reconcile.ts)与[协作测试](../../tests/topic-secretary.test.ts)：并行协调、完成与恢复边界。
