# Personal 业务模型

Personal 是 Aide 的内置个人助手插件：Chief 接收输入并判断是否需要持续跟进，Task 负责有限目标，Routine 负责持续职责。用户可以自然聊天，外部系统也可以带来观察；只有值得承担和推进的工作才进入 Task / Routine。

## 主流程

```text
Channel 用户消息 ──┐
                  ├→ Input → Conversation → Chief Controller → Chief Harness
Source 外部观察 ──┘                              │                  │
                                                 │ ask / confirm    ├→ 直接回复 / 忽略观察
                                                 ↓                  └→ Work 工具
                                            用户决定                    │
                                                 └→ 继续判断      Task / Routine
                                                                       │
                                                              各自 Reconcile → Harness
```

Chief 是业务角色。Chief Controller 消费输入、组织上下文并续接问答；Chief Harness 执行 `agents/chief/` 中的 Agent，使用通用 Pi 能力以及 Personal 工具。Task / Routine 默认使用 Codex 执行。Chief 的提示词、上下文和记忆优化方向见 [Chief Harness](../harness/chief.md)，插件机制见 [Plugin](README.md)。

## 输入与上下文

Chief 观察 Host 内置 Conversation 的变化，按会话串行消费 Input。一个会话同时只有一个活跃输入；其它输入排队，避免争用同一份 Work 工具绑定。等待某个会话的用户或 Harness 时，其它会话可以继续。

Input 与 Work 有不同生命周期。普通提问可以处理完就回复，只有有限目标或持续职责才进入 Work。Channel 与 Source 决定输入所属会话，具体映射见 [Channel](../channel/README.md) 和 [Connector 与 Source](../connector/README.md)；内置对象的存储由 [Kernel](../kernel.md) 管理。

每个会话绑定一个 Chief Target；每份输入使用独立 Lane，询问后的续答继续同一原生 Pi 会话。Chief 获取近期消息，并通过工具查询已有工作和外部详情；当前没有通用长期记忆。

编程领域使用 Repository = forge + path、Requirement = source + category + id、PR/MR = forge + path + number。Chief 在工作指令中保留实体身份与工作目录，不根据仓库名字猜测本地 checkout。

## 决策与问答

Chief 拥有原生文件/CLI 工具、五个 Work 工具，以及 `read_requirement`、`list_pull_requests`、`read_pull_request`、`read_pull_request_comments`、`list_connectors`。

`ask` 和 `confirm` 工具提出问题意图，Pi 结束当前 Turn 后，Chief Controller 调用已有 Core verb。等待用户不占模型执行位。Core Interaction 持有问题、答复、取消和超时；没有增加第二套审批状态。提出问题之后，当前轮的 Work 写工具拒绝继续修改，收到答复后才重新开放。拒绝是正常业务答案，Chief 收到 `declined`，不能当作执行授权。

网页可直接回答 Interaction；飞书同一会话下一条文字回答当前问题。确认问题接受选项值、标签和明确的“确认／拒绝”等表达；不明确的确认回答会提示选择，不继续执行。自由问答允许文字答案。其它会话的消息不能回答这个问题。当前一次只处理一个问题，不支持飞书引用特定历史问题作答；Hooks 信任和 Harness 权限请求仍在网页处理。

Source 观察没有用户指令的地位。Chief 应读取详情、查询已有 Work；在已有委托内可以推进工作，缺少目标或授权时询问。不值得打扰的观察可调用 `dismiss_observation`，保存原因但不向 Channel 发消息。

普通回复保存到 Conversation 的 Message 流，Input 保留消息引用，Core 问题按原 messageId 投影到同一 Channel 消息流。POST `/messages` 返回入站持久回执，业务结果异步出现；没有每次固定发出的“已创建事项”回复。模型进度不会重复投递为最终回复。

Chief 可能调用有副作用的工具，因此运行中断、失败或重启均不自动重放。状态和失败提示保留，用户核对后用新消息重新交办。同一输入 id 的传输重投永远不作为业务重试。等待中的调用栈不跨重启恢复，Core 问题会收口，Input 标记 failed；Work 的结果处理见下文。

## Task / Routine 与 Work

Task 与 Routine 各自的 Controller 观察 ready 或已到期的 scheduled，先保存 running，再请求 Harness 执行。正常结果、问题和状态一起提交；跨越执行等待后按 uid 重读资源，保留用户最新指令与暂停状态。版本冲突只重试提交，不重复执行外部工作。

执行返回 ask 时，工作保存为 waiting 并结束本次调用，用户回答后再唤醒；返回 wait 时保存动态唤醒时间。Routine 完成本轮后继续等待下一次触发，Task 完成后结束。事件触发更新匹配的 Routine，由其 Controller 推进。

`task.ts` 与 `routine.ts` 分别拥有 Reconcile：Task 完成后进入 done，Routine 完成本轮后回到 scheduled，并按自己的触发规则计算下次时间。两者共享 personal 内部的 Harness 调用、结果校验、并发更新处理和 outbox 记录；这些辅助操作位于 `execution.ts`，不进入通用 Host / Runner。

资源类型决定身份；Task 没有周期触发配置，Routine 必须有 cron 或事件触发。Work 工具与网页聚合这两类资源，对外仍返回 task / routine 分类。Chief 继续观察内置 Conversation。

改变工作类型由 Chief 组合现有工具：读取原工作的目标与结果，创建目标类型的新工作，再按用户意图暂停或删除原工作。新工作使用独立 id 和执行 Lane，相关上下文写入指令；保留原工作可查看完整历史，删除则将已交付消息与输入回执归档到 Conversation。各步分别持久化，不承诺跨资源的原子转换；中断后应查询现状再继续。暂停和删除都不取消已经运行的外部动作。

## Work 工具与执行结果

| 工具 | 行为 |
| --- | --- |
| `list_work` | 列出绑定会话的 Task / Routine |
| `read_work` | 读取目标、状态、历史、revision 和待回答问题 |
| `create_work` | 创建工作并唤醒对应 Reconcile |
| `update_work` | 修改定义、补充回答、暂停或恢复 |
| `delete_work` | 请求删除，停止后续调度并保留已交付消息 |

WorkService 绑定宿主确定的 conversationId，模型不能传入其它会话范围。读操作不唤醒执行，更新和删除需要最近读取的 revision；工具不能直接写入完成状态。删除前归档消息和输入回执，已运行回调不能重建被删资源。

Task / Routine 校验 Harness 的 finalText。执行失败或中断标为 uncertain，执行已结束但结果无法解析或校验则标为 invalid_result；两者均等待用户核对后明确继续，不自动重放。业务等待用户则保存为 waiting，收到回答后由 Reconcile 继续，能够跨服务重启恢复。

Chief 的问答使用 Core Interaction 与当前回调续接，调用栈不跨重启恢复；不能把它与 Task / Routine 的 waiting 状态混同。当前上下文来自近期消息、工作记录及连接器查询，尚无通用长期记忆。

## 验证

`tests/chief.test.ts` 验证真实 Runner、Pi SDK、需求观察、确认拒绝、自由回答和创建工作的链路；模型、平台与 Codex 执行使用替身。会话、独立 Task / Routine 生命周期和中断处理另有契约测试。真实环境验收见 [E2E](../e2e.md)。
