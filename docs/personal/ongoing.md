# Ongoing：持续跟进的事项

Ongoing 保存领域 Chief 承接的一件尚有下文的事。例如供应商准入材料提交后，审批可能持续数周。Chief 可以核实多次，始终更新同一个 Ongoing，直到获批、撤回或已有其他明确结论。Task 承接一次性目标，Routine 按轮次履行职责，Ongoing 则承接对同一件事的持续关注。新 Input 带来足够证据时，Chief 可以当轮收尾。

## Spec 与 Status

资源类型为 `aide.dev/v1alpha1 Ongoing`。Chief 先用 `list_work(kind="ongoing")` 查找已有事项，需要新增时调用 `upsert_work(kind="ongoing", title=…)`。更新前用 `read_work(id)` 读取当前版本，再用 `upsert_work(kind="ongoing", workId=…, version=…, …)` 记录进展、计划或结论。Ongoing 的 Topic 引用标明跟进归属。Secretary 到期提醒该领域的 Chief，Chief 直接研判新证据。创建使用当前领域 Topic，同一执行内重放创建调用复用同一 ID。更新按资源版本校验，写入事务核对 Chief 执行与 Topic 归属。

| 字段 | 含义 |
| --- | --- |
| spec.topic、title | 所属 Topic 的 UID 引用与事项名称 |
| spec.initialInputId、sourceUid | 首条业务 Input 的 ID，以及支持创建事项的来源 UID，两者均可选 |
| spec.question | 目前需要核实的问题 |
| status.nextCheckAt | 下次核实时间。创建时省略 checkAt，默认 24 小时后核实 |
| status.progress | 目前查明的进展与依据 |
| status.closure | 有结论后写入收尾时间 at 和结果 outcome，同时清除预约 |
| status.updatedAt、writer | 最近一次业务更新的时间、Chief 身份和执行 ID |
| status.followupInputId | 当前预约已递交的提醒 Input。调整预约后，Secretary 可再次递交 |

## 核实与收尾

Secretary 按保存的时间递交 `aide:followup`。Chief 先核对 Ongoing、新 Input、关联工作和 Me 已给出的答复。有结论就记录结果及依据并关闭。事情仍在推进就记录进展，按约定安排下次核实。若还缺影响判断的事实，先私下问 Me。询问只完成这次检查，事项仍可等待答复。新的业务 Input 可以直接更新同一事项。

编辑进展时省略 checkAt 会保留原计划，显式清空则表示等待外部消息。一次预约无论重试多少次都只产生一个 Input，变更或取消预约后，Secretary 撤下仍在队列中的旧预约。Chief 已经接到提醒时，可以先调整下次核实时间，再就仍然有效的问题询问 Me。开放事项及其所属 Topic 受容量回收保护。后续阶段的稳定事实与方法可以另外写入普通 Note，再按需提炼到对象摘要。Note 的梳理、拆分和退役各自独立于跟进责任。

`append_input` 可给 Ongoing 追加原始 Input 或当场记录的材料。Input 的 `status.handle` 按 Work UID 保存关联。Secretary 将新增材料的 ID 一起递交给领域 Chief，原有预约继续有效。Chief 用 `read_work` 查看关联 Input 和 Output。

Chief 在业务 Input 或跟进轮次中调用 `ask_me({ workId, text })` 私下询问 Me。Output 的 `spec.work` 指向事项，`purpose=question` 表示询问，`inputIds` 记录触发材料。预约时间变化不影响同一轮询问。事项已关闭或提醒中的问题已被替换时，旧提醒不能发问。同一事项、问题和触发材料重试时复用已接纳的 Output，实际送达结果见其 delivery 状态。
