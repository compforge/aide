# Task：有限目标与持续办理

Task 是同一 Conversation 下、围绕稳定工作范围持续办理的载体。`agents/task/` 与 `agents/chief/` 平级，复用 `agents/pi/` 和 PiAdapter。Task 使用自己的系统提示词和必要的领域工具；[Routine](routine.md) 使用独立 Agent，二者复用原生会话管理、输入接纳与回执机制，每个资源使用独立会话，各自管理生命周期。

## 目标与完成依据

Task 有明确的完成条件，没有周期职责的 trigger；执行和等待可以跨越多次调用。done 应有工具结果、产物或外部状态支撑，不能只凭模型说“完成”。report_task 提交结论与依据，say 在有必要沟通时单独表达结果。

Task 与 Routine 的区别由目标是否终结决定，执行次数与时长不决定类型。需要转换时，Chief 读取原目标和进展，创建新类型的独立资源，再按用户意图暂停或删除原资源。各步分别持久化，中断后核对当前状态；暂停或删除不撤销已发起的外部动作。

## 创建与输入

Chief 创建 Task 时通过 `create_work` 传入 `inputId`。Task.spec.initialInputId 和该 Input 的 handle 在同一事务建立；事务提交后 Task 才能执行。Chief 的 assess 回执独立确认，一个 Input 可以创建多个不同目标的 Task。创建去重包含 Conversation UID、初始 Input ID 和工具调用身份，同一次调用重试复用原 Task，不同目标使用不同身份。

没有外部 Input 的主动决定先经 `create_input` 记录为独立的 origin=chief Input，再创建 Task；它不会扩大已有委托授权。程序调用 WorkService.create 省略 inputId 时，将等价的独立 Input 与 Task 一起创建。

后续 Input 通过 Chief 的 assess_input 或独立 request_work 交给 Task。接收 Controller 应用确定性请求；agent Controller 负责持续执行。空闲时调用 prompt，运行中普通输入 followUp、immediate 输入 steer。Input.handle.executionId 先于提交持久化；一个 invocation 可以处理多条 Input，但每条办理结果独立确认。

## 工具与恢复

| 工具 | 职责 |
| --- | --- |
| read_task | 读取目标、状态、累计认识与近期依据 |
| read_input | 列出待处理 Input，或分页读取已分派的原始材料与办理痕迹 |
| read_conv | 读取所属 Conversation 的背景 |
| say | 通过 Conversation 创建用户可见 Output，关联 Task UID、execution 与可选 Input |
| report_task | 原子更新进展、done/wait/ask 状态及明确列出的 Input 办理回执 |

工具由 Host 根据 Task UID 和当前 execution 装配，模型不能自选其它 Task 或 Conversation。文件和 CLI 操作沿用 Pi 原生能力及现有凭证。Conversation 背景和外部材料不是新增授权。

`task.status.agent = { harness: "task", sessionId }`。Reconcile 先 create、保存 ID，再提交业务输入；恢复和持久化使用 [Pi 的原生 SDK](../harness/pi.md)。`status.execution` 表达当前执行，`lastExecutionId` 保留最近执行关联。模型 final text 不会完成 Input，也不会发送给用户；必须分别调用 report_task 和 say。中断或未确认输入保留痕迹并进入 uncertain，明确核对已有副作用后才能继续，不能自动重放。

report_task 的 done 表示本次目标已完成；若还有未确认 Input 则继续 ready。ask 保存问题并等待回答，wait 保存未来 nextAt。用户沟通与办理确认分别持久化，消息投递失败不会重跑工作。

## 静默与回收

执行结束、没有下一条可执行输入时，Reconcile 写入 idleSince。正在推理或执行工具不计入静默；新 Input 分派与清除 idleSince / agentStoppedAt 在同一事务提交，处理结束后重新计时。

静默达到 agentIdleMs 后 close 运行句柄，写入 agentStoppedAt，保留原生 sessionId；再经过 idleRetentionMs 才可回收 Task。保留期间的新 Input 可以恢复同一原生会话。默认值与范围见 [Task 静默策略](../configuration.md#task-静默策略)。

待处理 Input、paused / uncertain 状态、等待用户、未来 nextAt 都阻止 Task 回收，但允许释放空闲运行句柄。回收不以业务 done 为必要条件。达到回收条件后，以 UID 和 resourceVersion 前置条件请求删除，由资源层设置 deletionTimestamp；删除阶段关闭句柄、取消遗留办理记录，Controller 完成 finalize。

Chief 的列表过滤 deleting Task，分派事务也校验 UID、版本和 deletionTimestamp。分派先提交，旧的回收判断失效；删除先提交，新分派被拒绝。已进入删除流程的 Task 不撤销删除、不恢复执行。Task 资源回收不直接删除 SDK 会话文件或独立 Input / Output。

## 验证

`tests/task-agent.test.ts` 覆盖创建原子性、独立目标去重、明确回执、删除与分派竞争及两阶段回收。`tests/pi-agent.test.ts` 使用真实 Pi SDK、Runner 和模拟模型，覆盖 Task 工具、同一会话恢复和运行中的 followUp / steer；这些测试不代表真实模型或外部业务系统验收。
