# Task：有限目标与持续办理

## 整体定位

Task 是同一 Topic 下、围绕稳定工作范围持续办理的载体。`agents/task/` 与 `agents/chief/` 平级，复用 `agents/pi/` 和 PiAdapter。Task 使用自己的系统提示词和必要的领域工具；[Routine](routine.md) 使用独立 Agent，二者复用原生会话管理、输入接纳与回执机制，每个资源使用独立会话，各自管理生命周期。

当前归属保存在 `status.topic`，使用固定 UID 的 Topic 引用；spec 保存工作目标。Chief 可以在自己的树内调整空闲工作的归属，保留身份、进展、调度与办理回执；正在执行时拒绝迁移。

### 目标与完成依据

Task 有明确的完成条件，没有周期职责的 trigger；执行和等待可以跨越多次调用。done 应有工具结果、产物或外部状态支撑，不能只凭模型说“完成”。report_task 提交结论与依据，say 在有必要沟通时单独表达结果。

Task 与 Routine 的区别由目标是否终结决定，执行次数与时长不决定类型。需要转换时，Chief 读取原目标和进展，创建新类型的独立资源，再按用户意图暂停或删除原资源。各步分别持久化，中断后核对当前状态；暂停或删除不撤销已发起的外部动作。

## CRD

类型为 `aide.dev/v1alpha2 Task`。完整字段见 [模型](../../plugins/personal/task/model.ts)与[状态 Schema](../../plugins/personal/work-status.ts)。

### Spec

title、instruction 保存有限目标，initialInputId 指向初始 Input；paused 表达用户的暂停期望。Task 没有周期 trigger。

### Status

| 字段 | 含义 |
| --- | --- |
| topic / organization | 当前 Topic UID 与最近一次归属调整依据 |
| summary | 长期认识；recent 从独立 Note 查询，不在 status 中保存 |
| agent / execution / lastExecutionId | 原生会话、当前执行和最近报告的执行关联；execution 记录启动时的 observedGeneration |
| waiting | question 表达待回答问题，until 表达等待到期时间 |
| recovery / recoveryNotice | 需核对的结果或副作用，以及待创建的恢复通知 |
| lastReport | 最近一次办理报告，与长期认识分开 |
| idleSince / agentStoppedAt | 静默与运行句柄释放进度 |
| completion | 当前目标的结果与依据，含 at、text、observedGeneration 和可选 executionId |

Succeeded 只确认 completion 对应当前 metadata.generation；NeedsAttention 表示 recovery 或等待用户回答。状态构造函数与办理事实一起更新条件，通用规则见 [Conditions](../plugin/resource.md#conditions-契约)。

## Reconciler

### 创建与输入

Chief 创建 Task 时通过 `create_work` 传入 `inputId`。Task.spec.initialInputId 和该 Input 的 handle 在同一事务建立；事务提交后 Task 才能执行。Chief 的 assess 回执独立确认，一个 Input 可以创建多个不同目标的 Task。创建去重包含 Topic UID、初始 Input ID 和工具调用身份，同一次调用重试复用原 Task，不同目标使用不同身份。

没有外部 Input 的主动决定先经 `create_input` 记录为独立的 origin=chief Input，再创建 Task；它不会扩大已有委托授权。程序调用 WorkService.create 省略 inputId 时，将等价的独立 Input 与 Task 一起创建。

后续 Input 通过 Chief 的 assess_input 或独立 request_work 交给 Task。接收 Controller 应用确定性请求；agent Controller 负责持续执行。空闲时调用 prompt，运行中普通输入 followUp、immediate 输入 steer。Input.handle.executionId 先于提交持久化；一个 invocation 可以处理多条 Input，但每条办理结果独立确认。

### 静默与回收

执行结束、没有下一条可执行输入时，Reconcile 写入 idleSince。正在推理或执行工具不计入静默；新 Input 分派与清除 idleSince / agentStoppedAt 在同一事务提交，处理结束后重新计时。

静默达到 agentIdleMs 后 close 运行句柄，写入 agentStoppedAt，保留原生 sessionId；再经过 idleRetentionMs 才可回收 Task。保留期间的新 Input 可以恢复同一原生会话。默认值与范围见 [Task 静默策略](../configuration.md#task-静默策略)。

待处理 Input、paused / uncertain 状态、等待用户、未来等待时间都阻止 Task 回收，但允许释放空闲运行句柄。回收不以业务 done 为必要条件。达到回收条件后，以 UID 和 resourceVersion 前置条件请求删除，由资源层设置 deletionTimestamp；删除阶段关闭句柄、取消遗留办理记录，Controller 完成 finalize。

Chief 的列表过滤 deleting Task，分派事务也校验 UID、版本和 deletionTimestamp。分派先提交，旧的回收判断失效；删除先提交，新分派被拒绝。已进入删除流程的 Task 不撤销删除、不恢复执行。Task 资源回收不直接删除 SDK 会话文件或独立 Input / Output。

### 执行与恢复

`task.status.agent = { harness: "task", sessionId }`。Reconcile 先 create、保存 ID，再提交业务输入；恢复和持久化使用 [Pi 的原生 SDK](../harness/pi.md)。`status.execution` 表达当前执行，`lastExecutionId` 保留最近执行关联。模型 final text 不会完成 Input，也不会发送给用户；必须分别调用 report_task 和 say。中断或未确认输入保留痕迹并进入 uncertain，明确核对已有副作用后才能继续，不能自动重放。

## Agent

### 工具与恢复

| 工具 | 职责 |
| --- | --- |
| read_task | 读取目标、状态、累计认识与近期依据 |
| read_input | 列出待处理 Input，或分页读取已分派的原始材料与办理痕迹 |
| list_work | 分页查看同会话 Task / Routine 概况，不获得其它 Work 的操作权限 |
| read_topic | 读取所属 Topic 的背景 |
| say | 通过 Topic 创建用户可见 Output，关联 Task UID、execution 与可选 Input |
| summarize_task | 独立修订本资源的长期认识 |
| upsert_note | 按同一事项创建或更新近期 Note，目标由 Host 绑定 |
| report_task | 原子更新进展、done/wait/ask 状态及明确列出的 Input 办理回执 |

工具由 Host 根据 Task UID 和当前 execution 装配，模型不能自选其它 Task 或 Topic。文件和 CLI 操作沿用 Pi 原生能力及现有凭证。Topic 背景和外部材料不是新增授权。

report_task 的 report 保存本次办理说明并更新 lastReport，不改写 summary 或 Note。done 表示本次目标已完成；若还有未确认 Input 则继续 ready。ask 保存问题并等待回答，wait 保存 waiting.until。用户沟通与办理确认分别持久化，消息投递失败不会重跑工作。

执行开始记录目标或职责版本。spec 在执行途中改变时，旧报告不能确认新版本；Agent 需用 read_task 重新读取资源、核对结果，并显式报告当前 observedGeneration。暂停期间可以保存旧执行针对原版本的结果，但不能据此确认新版本目标。

### Context View

以下是 prompt 的文本大纲；system 放固定规则，user 分为动态业务背景与本轮输入。背景包括配置后的 Me 身份认识；工具定义与执行历史由 Harness 提供。

#### 上下文组织与优化

Task 的上下文围绕当前有限目标组织。当前采用以下消息结构组织持续办理；常驻背景使用 Pi custom → user 投影，通用语义见 [Route 上下文组织](route.md#上下文组织与优化)。

Task 使用本资源目录下的 [Background](../../plugins/personal/task/background.ts)，保存自身目标与进展、所属会话和相关 Work 的当前快照。`background()` 在每次模型请求前重新构造它，`Background.text()` 只负责文本化，Harness 将结果作为 custom → user 前缀。快照构造后不随资源变化而改变；下一次请求再取得新快照。通用契约见 [Pi 当前业务背景](../harness/pi.md#当前业务背景)。

```text
system：Task 的固定职责、执行约束和报告契约
custom → user：Background.text()，当前业务背景 v1
  objective：自身目标、完成条件、状态、长期 summary、有限 Note 与 lastReport
  topic：所属话题背景
  work：同一 Topic 的相关 Task / Routine 概况
user：Input 1
assistant / tool：执行、按需 say、report_task 提交进展与办理回执
后续请求的 custom → user 前缀：objective 进展 v2     # 由已提交的资源状态刷新
user：Input 2
assistant / tool：结合已有进展继续办理
user：Input 3                         # 状态没变，背景前缀不变
assistant / tool：处理与回执
```

自身状态与相关 Work 概况用于承接目标、识别重复办理和协作关系，不默认装入全局所有工作及完整历史，也不授予操作其它 Work 的权限。Input、工具结果与外部证据保持可追溯；当前进展以资源中的报告为准，模型发言不等于目标完成。

业务背景是请求投影，不追加到原生 transcript，也不参与历史压缩；恢复后从 CRD 重建。

summary 与 Note 的职责、工具和预算见[有界认识与近期依据](README.md#有界认识与近期依据)。常驻 summary 最多预览 8000 字符，recent 最多 3 条、每条 500 字符；所属会话的 Work 列表按 20 项和约 16000 个 JSON 字符分页。省略信息通过读取工具补查，完整事项保存在独立 Note 中，通过 read_note 读取。

优化重点是新输入能否接上已有进展、是否重复执行已完成动作、是否遗漏阻塞和完成条件。根据实际轨迹调整目标与状态的呈现、相关工作范围、近期证据预算和工具补查时机，比较完成质量、重复动作、上下文大小与处理耗时；恢复仍须核对不确定副作用。

## 验证

`tests/task-agent.test.ts` 覆盖创建原子性、独立目标去重、明确回执、删除与分派竞争及两阶段回收。`tests/pi-agent.test.ts` 使用真实 Pi SDK、Runner 和模拟模型，覆盖 Task 工具、同一会话恢复和运行中的 followUp / steer；这些测试不代表真实模型或外部业务系统验收。

[状态测试](../../tests/status.test.ts)覆盖目标版本、条件更新和 Task / Routine 完成语义的区别。
