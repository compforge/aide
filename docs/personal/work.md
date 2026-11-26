# Work

Work 记录一次 Input 处理结束后仍要推进的事。一次答复可以直接完成；产生后续责任时，先查已有 Work，再决定追加材料或创建资源。

| 类型 | 选择依据 | 以供应商审批为例 | 完成条件 |
| --- | --- | --- | --- |
| Task | 一个有明确完成条件的目标 | 补齐并提交申请 | 有提交回执等证据支持目标达成 |
| Routine | 按时间或事件反复履行一项职责 | 每周汇总审批情况 | 每轮有结果，职责持续 |
| Ongoing | 同一事项尚有下文，值得持续跟进 | 申请已提交，继续核实这一次审批 | 有获批、撤回等明确结论 |

## 查询与交接

Chief 用 `list_work` 查当前领域子树，可按 kind 筛选，`includeClosed` 可纳入已关闭的 Ongoing；`read_work(id)` 读取详情。Gate 可按 kind 跨 Topic 查询。普通 Task 和 Routine Agent 用 `list_work` 查看相关工作，分别通过 `read_task`、`read_routine` 读取自身目标和状态。[Chief 工具](../../plugins/personal/work/agent/tools.ts) · [Gate 查询](../../plugins/personal/gate/read-tools.ts)

Chief 用 `upsert_work` 声明目标、职责或事项。复盘时从原始业务 Input、Note 或 Work 派生责任，可传 `sourceId` 保留依据；同一来源可支持多个不同目标。新的材料通过 `append_input` 关联已有 Work，批次中的原始材料使用成员 Input ID。Input 按 Work UID 保存各自的办理关系。[Input](input.md)

## Task

Task 的 spec 保存有限目标和初始 Input。创建时传 `instruction`、`trigger: null` 和业务 `inputId`，或在既有授权下引用 `sourceId` 形成一条 Chief 委托。初始 Input 与 Task 的关联原子建立。Task 可跨多轮执行与等待，完成时提交结果、依据和对应的目标版本。[Task 模型](../../plugins/personal/task/model.ts)

执行结束且没有可办理材料后开始静默计时。达到 `agentIdleMs` 释放运行句柄并保留 sessionId；再经过 `idleRetentionMs` 可回收符合条件的 Task。待处理 Input、暂停、等待回答、未来唤醒或待核对状态都会阻止回收。新分派清除静默计时；删除与分派并发时由 UID、版本及删除状态决定哪项可以提交。[配置](../configuration.md#task-静默策略) · [Task 测试](../../tests/task-agent.test.ts)

## Routine

Routine 的 spec 保存持续职责和 trigger。创建时指定 `instruction` 和带时区的 cron 或事件规则。定时唤醒可直接开始一轮；事件和新的业务材料可以关联原始 Input。一次 done 完成本轮，仍有待办时继续办理，否则按 cron 计算下一次时间，纯事件职责等待事件。静默只释放运行句柄，职责和原生会话引用保留到显式删除。[Routine 模型](../../plugins/personal/routine/model.ts) · [配置](../configuration.md#routine-静默策略) · [Routine 测试](../../tests/routine-agent.test.ts)

### 受托 Agent 的办理与恢复

Task 与 Routine 由各自的 Agent 执行。两者的当前归属均保存在 `status.topic`；空闲时可在责任树内迁移。修改目标以资源 generation 标记版本。更换工作类型时，创建新资源并按用户意图暂停或删除旧资源。

- **接纳与执行。** Reconciler 先保存执行和会话身份，再提交 Input。空闲时使用 prompt，运行中按紧迫程度使用 followUp 或 steer。同次执行可处理多条 Input；每条的办理回执独立确认。
- **报告与等待。** `report_work` 原子记录本轮进展、依据和实际办理的 inputIds。done 提交结果，ask 保存待回答问题，wait 保存下次唤醒时间。对外提问或通知通过 `say` 创建 Output。目标中途变更时，Agent 重读目标后才能以当前 observedGeneration 确认结果。
- **上下文与知识。** system prompt 说明本角色职责，每轮请求从 CRD 加载目标、状态、所属 Topic、相关 Work 和 Me。摘要记录长期有用的认识，通过 `upsert_note` 创建普通 Note 时指定 semantic 或 procedural。原始材料和完整正文按需读取。[Note](note.md) · [Pi 当前业务背景](../harness/pi.md#当前业务背景)
- **恢复。** 中断后保留执行痕迹；未确认的办理或外部副作用进入 uncertain，核对后再继续。已持久化的 Output 由投递器独立重试。[共享状态](../../plugins/personal/work/agent-status.ts) · [办理测试](../../tests/work-context.test.ts)

## Ongoing

Ongoing 记录尚有下文、值得持续跟进的同一事项。例如供应商准入材料提交后，审批可能持续数周。目前由领域 Chief 处理核实请求，可以核实多次，始终更新同一个 Ongoing，直到获批、撤回或已有其他明确结论。Task 承接一次性目标，Routine 按轮次履行职责，Ongoing 则承接对同一件事的持续关注。新 Input 带来足够证据时，Chief 可以当轮收尾。

### Spec 与 Status

资源类型为 `aide.dev/v1alpha1 Ongoing`。Chief 先用 `list_work(kind="ongoing")` 查找已有事项，需要新增时调用 `upsert_work(kind="ongoing", title=…)`。更新前用 `read_work(id)` 读取当前版本，再用 `upsert_work(kind="ongoing", workId=…, version=…, …)` 记录进展、计划或结论。Ongoing 的 Topic 引用标明跟进归属。Secretary 到期提醒该领域的 Chief，Chief 直接研判新证据。创建使用当前领域 Topic，同一执行内重放创建调用复用同一 ID。更新按资源版本校验，写入事务核对 Chief 执行与 Topic 归属。

| 字段 | 含义 |
| --- | --- |
| spec.topic、title | 所属 Topic 的 UID 引用与事项名称 |
| spec.initialInputId、sourceUid | 首条业务 Input 的 ID，以及支持创建事项的来源 UID，两者均可选 |
| spec.question | 目前需要核实的问题 |
| status.nextCheckAt | 下次核实时间。创建时省略 checkAt，默认 1 小时后核实 |
| status.progress | 目前查明的进展与依据 |
| status.closure | 有结论后写入收尾时间 at 和结果 outcome，同时清除预约 |
| status.updatedAt、writer | 最近一次业务更新的时间、Chief 身份和执行 ID |
| status.followupInputId | 当前预约已递交的提醒 Input。调整预约后，Secretary 可再次递交 |

### 核实与收尾

Secretary 按保存的时间递交 `aide:followup`。Chief 先核对 Ongoing、新 Input、关联工作和 Me 已给出的答复。有结论就记录结果及依据并关闭。事情仍在推进就记录进展，按约定安排下次核实。若还缺影响判断的事实，先私下问 Me。询问只完成这次检查，事项仍可等待答复。新的业务 Input 可以直接更新同一事项。

编辑进展时省略 checkAt 会保留原计划，显式清空则表示等待外部消息。一次预约无论重试多少次都只产生一个 Input，变更或取消预约后，Secretary 撤下仍在队列中的旧预约。Chief 已经接到提醒时，可以先调整下次核实时间，再就仍然有效的问题询问 Me。开放事项及其所属 Topic 受容量回收保护。后续阶段的稳定事实与方法可以另外写入普通 Note，再按需提炼到对象摘要。Note 的梳理、拆分和退役各自独立于跟进责任。

`append_input` 可给 Ongoing 追加原始 Input 或当场记录的材料。Input 的 `status.handle` 按 Work UID 保存关联。Secretary 将新增材料的 ID 一起递交给领域 Chief，原有预约继续有效。Chief 用 `read_work` 查看关联 Input 和 Output。

Chief 在业务 Input 或跟进轮次中调用 `ask_me({ workId, text })` 创建发给 Me 的私聊 Output。Me 的 Person 投递频控决定实际发送时间，命中频控时 Output 保持 pending，等待重新投递。Output 的 `spec.work` 指向事项，`purpose=question` 表示询问，`inputIds` 记录触发材料。预约时间变化不影响同一轮询问。事项已关闭或提醒中的问题已被替换时，旧提醒不能发问。同一事项、问题和触发材料重试时复用已接纳的 Output，实际送达结果见其 delivery 状态。

Me 可以在 Web Gate 的 Work 列表里打开任一开放事项，补充最新进展、结论或对问询的答复。提交将原文作为用户 Input 追加到事项，Secretary 通知所属领域的 Chief。Chief 根据补充更新进展或记录结论并关闭。
