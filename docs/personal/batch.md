# Batch

Batch 是 Personal 的独立 CRD，对 Chief 表现为一条特殊的输入：接纳、处理、完成。当前只用于将积压的 Deferred Input 组成一个按 Normal 优先级处理的任务。Normal、Immediate、内部维护和显式 handoff 继续独立处理。

## 成员与调度

Input 保存原始事实、origin、attention、权限依据与 Work 办理回执。成员关系的唯一事实是 `Input.status.batchId`，值为 Batch UID；`batchAt` 记录归组时间，两者一起写入，归组后不可修改。Batch 不保存 inputRefs、inputIds 或成员计数，成员通过 Input 的 batch 索引查询。

[Secretary](secretary.md) 按 `topic.deferred.count` 和 `maxWaitSeconds` 检查数量与最早等待时间。同一来源、originId、材料 Topic、Address、sender、分类与授权上下文的 Deferred Input 可以组批，每批最多 10 条。Batch.spec 保存处理 Topic、attention 和 oldestAt，当前 attention 为 Normal。批次是 Normal 调度项，原 Input 仍为 Deferred；组批不会扩大权限，也不会获得 steer 资格。

创建并完成归组后成员固定：1、2、3 组成 Batch A 后，到来的 4 留在待办，不能追加进 A；A 排队、执行和终结都不改变成员身份。Immediate 优先进入；运行中最多有一个尚未完成的 Batch，其余 Batch 等待。批次配额不足时保留原始 Deferred 待办并定时重试，不走第二套提级机制。

## 生命周期与职责

- preparing：Secretary 创建 Batch。成员归组与 ready 在同一事务提交；失败不留下半组成员，中断留下的空 preparing 资源由后续协调取消。
- ready：固定成员的批次可被 Chief 接纳。事务内检查成员和真实处理归属，防止与独立研判并发重复领取。
- running：Chief 原子更新 Topic execution 与 Batch 回执。成员不领取独立 execution，不进入独立调度。
- completed：Chief 调用 `assess_batch` 确认整个任务，Batch.status.assess 复用 Input 的 Assessment，保存 result、completedAt 和 completedBy。可同时交办 Work，但必须指定原成员 Input 并遵守原始权限；Work 完成是独立事实。
- failed：明确记录的终态失败，不再接纳。执行异常或缺少完成回执只记录可重试错误并退回 ready，等待角色 trigger 间隔后重试同一 Batch；成员不拆散。
- cancelled：Secretary 在接纳前发现材料过期或处理归属失效时取消安排。成员关系仍保留，并通过回填得到取消原因。

Input Reconcile 监听 Batch 终态，按 batchId 将完成或失败回执投影到成员 assess。回填可重复执行，重启后仍能继续；Chief 不等待或逐条写成员回执。运行中的执行身份直接以 Batch 为准，不能依赖异步投影。`assess_input` 拒绝独立研判 Batch 成员。

Batch.status.phase 表达准备与调度阶段，status.assess 与 Input 使用同一执行、完成及错误回执结构；不另设 summary、error 或 finishedAt 同义字段。

初次 prompt 与运行中 followUp 都展开固定成员的原始证据，并携带 batchId。原生投递明确拒绝时仅将尚未完成的 Batch 退回 ready；结果不明时保留 running 和可重试错误，待执行结束后回到 ready；已提交的 Batch 完成回执不会被覆盖。只有 Topic Chief/Gate Reconcile 触发 Agent，Batch 不持有独立会话。

## 保留与恢复

Batch 未终结或成员尚未回填时，成员不能删除或被容量回收。Batch 在成员回填完成前也不能删除，避免执行事实丢失。成员持有对 Batch 的引用；正常回收在终结、投影完成并满足引用与保留规则后进行。

Secretary 协调未接纳 Batch，Chief 负责运行中 Batch 的执行恢复，Input Reconcile 负责成员结果投影。实现位于 `plugins/personal/batch/`；独立 Input 与 Batch 的选择位于 `chief/intake.ts`。验证见 `tests/input-batch.test.ts` 与 `tests/input-admission.test.ts`。
