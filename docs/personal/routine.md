# Routine：持续职责与每轮办理

Routine 是同一 Conversation 下持续存在的委托职责。`agents/routine/` 与 Chief、Task 平级，拥有独立提示词和领域工具，复用 Pi SDK 与 PiAdapter。它比较新旧观察、处理值得推进的变化，必要时通过 say 通知或询问用户。

## 触发与执行

Routine.spec.trigger 声明 cron 或事件订阅。cron 到期可以在没有 Input 时启动一轮；事件形成 Input 并为匹配的 Routine 建立 handle。Chief 的 assess_input 或 request_work 也能向已有 Routine 提供材料和决定。事件 Input 不需要虚构 Chief assess 记录。

接收 Controller 应用确定性请求，agent Controller 调用持续会话。先保存 status.execution 和 Input 的接纳痕迹，再提交原生执行；运行中普通 Input 通过 followUp 追加，immediate 通过 steer 追加。每条 Input 的业务回执独立于原生接收回执。

## 工具与结果

| 工具 | 职责 |
| --- | --- |
| read_routine | 读取职责、触发条件、当前状态、累计认识和近期依据 |
| read_input | 列出待处理 Input，或分页读取分派给当前 Routine 的材料 |
| read_conv | 读取所属 Conversation 背景，不扩大委托授权 |
| say | 创建用户可见 Output，关联 Routine UID、execution 和可选 Input |
| report_routine | 原子提交进展、当前轮次状态和明确列出的 Input 回执 |

工具绑定宿主确定的 Routine UID；每次调用检查当前 execution，模型不能选择其它资源范围。文件、CLI 和能力包使用 Pi 原生机制与现有凭证。

report_routine 的 inputIds 必须是已接纳、已处理的输入，与一次资源状态更新共同提交。未列出的 Input 不会被确认。summary 替换累计认识，recent 追加本次依据，均遵守 Personal 的有界保留约定。

- done 完成本轮。尚有未确认 Input 时继续 ready，否则回到 scheduled；cron 重新计算下次时间，纯事件职责保持 nextAt=null 等待事件。
- ask 保存问题并进入 waiting，问题通过 say 单独发送；回答经 Chief 分派为新 Input 后继续。
- wait 保存未来 nextAt 并结束当前调用，到期再唤醒；不用长时间 sleep 占用执行。

finalText 只保留为执行记录，不解析为业务结果、不自动发送给用户。没有回执的已接纳 Input 或没有报告的定时执行进入 uncertain，保留错误和执行关联。明确恢复前先核对已有副作用，不自动重放。暂停期间收到报告仍保留 paused。

say 和 report_routine 分别持久化。Output 投递失败只重试投递，不重复本轮工作。新发现若需要独立目标，可通过 say 提出后续 Task，由 Chief 安排；Routine 不自行扩展职责。

## 会话与生命周期

`routine.status.agent = { harness: "routine", sessionId }`。Reconcile 通过 create 获取并持久保存原生 ID，再提交业务输入；恢复依赖 Pi SDK 的初始化、持久化及按 ID 查找，不复制会话文件或维护第二份历史。status.execution 与 lastExecutionId 记录当前及最近执行。

执行结束、没有下一条可执行 Input 后写入 idleSince；正在推理和执行工具不算静默。静默达到配置时长后 close 运行句柄并记录 agentStoppedAt，保留 sessionId。新事件或 Chief 分派与清除计时在同一事务提交；cron 到期在启动时清除计时。

Routine 没有静默资源回收阶段。职责、trigger 和累计认识持续保留，后续触发恢复同一原生会话。显式删除才设置 deletionTimestamp；分派和事件匹配拒绝 deleting 目标，删除 Reconcile 关闭句柄、取消遗留 handle 后由框架 finalize。

模型和包分别配置在 harnesses.routine.model / packages，模型缺省复用 Chief，packages 缺省为空且独立同步。静默时长由 plugins.personal.routine.agentIdleMs 配置，见 [配置](../configuration.md)。

## 验证

`tests/routine-agent.test.ts` 覆盖轮次报告、静默释放、定时恢复、职责保留和删除隔离。`tests/work-context.test.ts` 覆盖精确回执、事务回滚、接纳冲突和有界进展。`tests/pi-agent.test.ts` 使用真实 Pi SDK、Runner 和模拟模型验证专属工具、事件 Input 的 say、跨重启恢复、followUp / steer 与独立能力包；不代表真实模型及外部业务系统验收。
