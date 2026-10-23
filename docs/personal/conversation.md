# Conversation：话题与研判

Conversation 承载持续变化的话题、近期关注与相关委托。Chief 在这个范围内判断新事实，直接处理简单事情，或交给 Task / Routine 独立推进。输入归属由 [Route](route.md) 决定。

## 接纳与连续执行

Conversation 的接收 Controller 通过 Input.assess 索引发现待研判项，处理确定性协调；具名 agent Controller 驱动 Chief。空闲时 prompt，运行中普通输入 followUp、immediate 输入 steer；接纳前先保存 executionId，重复协调不会重复提交已接纳材料。

明确拒绝 steer 时释放本次接纳记录，让材料等待 followUp；结果未知则保留证据。Chief 可能已调用外部工具，服务重启或执行失败时不能自动重放。后续输入或定时回顾可核对已有动作后明确确认。

Conversation 的 status.agent 保存所选 Harness 与原生 sessionId，Operator 将其作为调用参数。原生持久化和恢复由 Harness 负责；保存引用成功后才提交业务材料。运行句柄与 invocationId 仅用于进程内协调和展示。

## 研判与上下文

assess_input 明确完成单条输入的研判：本次 summary 写入 Input 回执和 Conversation.recent，合并旧认识后的 conversationSummary 替换 Conversation.summary，并原子建立必要的 Work handle。say 独立创建 Output，不代替研判回执。

summary 描述话题、相关委托、关键结论和未决问题；recent 保留近期依据。Chief 通过 read_input 获取最新上下文与版本，更新冲突时重读后合并。没有 Input 的定时回顾使用 summarize_conversation 更新认识，不虚构消费记录。原生上下文承接连续推理，跨话题记忆由 [Chief](chief.md#上下文与记忆) 管理。

预览与摘要预算见 [Conversation 配置](../configuration.md#conversation-消费策略)。Input 的完整内容可按需读取；近期窗口的裁剪不代表工作目标已经完成。共同语义见 [有界认识与近期依据](README.md#有界认识与近期依据)。

## 地址与问答

Conversation.spec.address 只在由 Channel Input 创建时取首个 Input.source。后续追加不覆盖，Source 观察地址不自动成为默认联络地址。具体回复选择见 [Output](output.md#地址与收件处)。

Chief 用 say 发出普通问题并结束当前调用；用户后续回答作为新 Input 进入。对话上下文帮助理解回答，消息不会自动转换为权限确认。Harness 原生权限与 Hook 信任由独立 Approval 处理。

## 默认联络处

Conversation 的 `spec.default` 标记用户选择的默认联络处，缺省为 false。整个 Aide 实例最多有一个默认会话。用户通过 Web 设置或取消；切换通过资源事务清除旧标记并设置新标记，存储校验保证最多一个默认。删除或取消默认后，下一次需要兜底时 Route 会建立默认会话。

默认会话使用普通 Conversation 的上下文、Work 和 Chief Reconcile，承接没有合适话题的输入。已有明确目标的输入直接交给对应话题；是否值得回复、提醒、询问或推进工作，由承接的会话判断。需要用户处理的 Aide 服务问题也须先作为 Input 提交，不直接广播错误日志。

默认标记不打开 trigger、不授予额外执行权限，也不合并其它会话的上下文。个人私聊适合作为默认联络处，工作群继续承载各自话题。

## Conversation 定时回顾

Conversation 与 Routine 的 `trigger` 都是调度机制，只决定何时唤醒 Reconcile；业务判断由各自 Reconcile 负责。Conversation 的定时触发用于持续照看话题。每个 Conversation 独立控制开关与间隔，默认关闭、间隔一小时；Web 提供开关。收到新 Input 和 trigger 到期都会唤醒同一个 Conversation Reconcile，定时唤醒已有明确上下文，不生成外部 Input。

Personal 决定回顾策略，Core 提供通用定时唤醒与恢复能力。Runner 根据 Reconcile 返回的重新入队时间调度，下一次回顾时间与每次处理记录保存在 Conversation 中，重启后恢复，停机错过的周期合并处理；普通消息不会不断推迟到期回顾。回顾与输入处理按会话协调，避免堆积重复工作。关闭 trigger 停止后续定时回顾，已有 Input、Work 与 Source 继续遵循各自生命周期。

Conv 的回顾关注话题中的遗漏、进展、阻塞和可采取的下一步，Routine 的定时触发则承担明确的本轮职责。回顾可以静默结束；需要执行时依据已有委托，需要补充信息或用户决定时再询问。记忆中的意向不自动成为执行委托，也不重复提出没有新依据或用户回应的建议。

Chief 可以推进已有委托、用 say 提出建议或问题，或静默结束。`say` 保存独立 Output，由 Channel 独立投递；用户回复 say 是新的 Channel Input。定时回顾仅在有实际消息或问题时通知用户，静默回顾的内部总结不渲染为回复。

## 删除与验证

会话删除核对 UID、版本、未完成输入、执行与关联 Work。删除后同名重建获得新的 UID，上一个实例的输出和执行不会混入新话题。共享 Input 与独立 Output 按各自生命周期保留。

`tests/conversation-intake.test.ts`、`tests/conversation-trigger.test.ts`、`tests/default-conversation.test.ts` 与 `tests/conversation-delete.test.ts` 覆盖接收、回顾、默认与删除；`tests/chief.test.ts` 和 `tests/pi-agent.test.ts` 覆盖持续执行与工具。
