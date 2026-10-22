# Route Harness

Route 为新 Input 寻找合适的 Conversation。确定性规则处理明确归属，Route Agent 判断其余输入与已有话题的关系，再通过 `route_input` 提交分派决定。一个 Input 可以进入多个 Conversation，各 Conversation 的 Chief 独立处理和确认消费。

```text
Channel / Source → 持久 Input → 确定性规则
                                ├─ 命中 → 幂等追加到 Conversation
                                └─ 未命中 → Route loop → route_input
                                                          ↓
                                              保存计划 → 幂等追加
                                                          ↓
                                              Chief → complete_inputs
```

没有任何 Conversation 时，直接建立 Default 承接输入，无需调用模型。整体业务流程见 [Personal](../plugin/personal.md#输入与上下文)，通用执行契约见 [Harness](README.md)。

## Agent 与 Controller

`Route/global` 是 Personal 的单例资源，保存待分派的 `pendingInputIds` 和当前 execution。两个 Controller 观察同一资源，拥有独立队列：

| 组件 | 职责 |
| --- | --- |
| 默认 Controller | 发现未完成路由的 Input、尝试确定性规则、续投已保存计划、清理已完成队列项、接纳 immediate |
| 具名 `agent` Controller | 将待判断的输入交给 Route Agent，复用原生上下文并安排后续调用 |
| Route Agent | 读取当前会话目录、输入和相关记忆，决定完整的目标集合 |
| 宿主绑定的工具 | 校验输入和目标身份，持久化决定并执行幂等投递 |

因此，Route 等待模型时，确定性归属的消息仍能进入 Conversation。资源和 Controller 定位执行上下文，`personal-route` 是该角色的 Harness Target；不另建内部 Session 充当业务资源。

确定性规则包括匹配 `Input.sessionId` 与 Conversation 话题，以及沿 `observation.originalInputId` 的投递凭据关联已有会话。讨论续报会等待原始输入路由完成。Channel 的明确新话题可以创建 Conversation；Source 的陌生话题线索本身不触发创建。

## 工具与完成条件

Route 使用以下工具，不加载文件、CLI 或 Work 执行能力，也不直接回复用户。

| 工具 | 用途 |
| --- | --- |
| `list_conversations({ offset? })` | 分页读取当前 Conversation 的 UID、名称、Default 标记和摘要 |
| `read_input({ inputId?, offset? })` | 读取待分派 Input 的描述；省略 inputId 时列出待处理 ID 与处理状态 |
| `route_input({ inputId, conversationUids, reason })` | 提交一条已接纳 Input 的完整分派决定 |
| `memory_search`、`session_search` | 检索与判断相关的共享记忆和历史 |

读取结果的 `nextOffset` 为 null 时表示该次分页结束。目录可能变化，Agent 应在判断前读取当前目录，不能只凭原生历史中的旧名称或 UID。

`route_input` 的三个字段分别是输入 ID、目标 Conversation UID 数组和判断理由。多个目标允许，空数组表示交给 Default。例如：

```json
{
  "inputId": "input-example",
  "conversationUids": ["conversation-uid-from-catalog"],
  "reason": "这条发布进展属于已有的故障跟进话题"
}
```

目标必须来自当前资源目录，不能编造。工具提交的是完整集合，不能先提交一个目标，再以第二次调用补充另一个目标。已有持久计划优先，已完成输入的重复提交不会重新分派。

宿主先把计划保存到 `Input.status.routing`，再按目标 UID 调用幂等追加；全部投递完成后标记路由完成，随后从 Route 队列移除。没有合适目标时使用用户选择的 Default；没有 Default 时建立无通信地址的默认会话。规则或语义命中其它目标时，不额外复制给 Default。

`route_input` 成功只表示分派完成。`complete_inputs` 仅向 Chief 暴露，确认的是某个 Conversation 对 Input 的业务消费；`say` 独立产生 Output。模型输出一段“已分派”的文本，或 HarnessInvocation 正常结束，都不能替代工具回执。

## 连续上下文与记忆

Route 对普通输入逐条 followup：当前调用结束后，以同一个原生上下文处理下一条。运行期间到来的 immediate 输入通过 Pi 原生 steer，在安全边界进入当前调用。明确拒绝或不支持 steer 时，输入留队等待 followup；投递结果不确定时保留证据。

这里的“持续”指上下文持续复用，并不要求模型始终处于生成状态。没有待处理输入时可以空闲；每次 HarnessInvocation 仍独立记录生命周期。Route 不保留 Batch 快照，原生历史、压缩和恢复绑定由 Pi SDK 与宿主管理。

Route 与各 Conversation 的 Chief 隔离原生上下文，共用 Hermes 长期记忆。Chief 可以维护记忆，Route 只获得检索工具。偏好和话题关系能辅助路由，但当前资源事实与用户明确纠正优先；输入、会话摘要和检索内容都作为证据，不授予执行权限。

## 恢复与幂等

启动后补扫持久 Input，可以恢复提交成功但未入 Route 队列的输入。未保存决定的分类可以退避重试；已有计划则只续投剩余目标，不重新询问模型改变归属。

追加以 Input ID 和 Conversation UID 去重。部分目标投递成功后发生中断，恢复不会让它们重复消费；新到输入也不会随旧输入完成而被移除。目标被删除时保留失败计划，不改投同名的新实例。

Route 待处理队列保护尚未分派完的 Input。投递后，目标 Conversation 的 pending 引用继续保护事实；各消费者释放后，Host 才能按资源容量策略回收。分类重试与 Chief 的动作恢复有不同边界：分派可以重试，已经尝试的外部动作不能因此自动重放。

## 配置、实现与验证

`harnesses.route.model` 可单独选择模型，缺省复用 Chief 的启动模型配置。Route 是固定的 Personal 角色，不能设为 `defaultHarness`。`plugins.personal.route.contextChars` 限制新输入预览，默认 16000 个字符；全文通过 `read_input` 分页读取。完整配置见 [Route 连续分类与模型](../configuration.md#route-连续分类与模型)。

实现入口：

- [Agent 与策略](../../agents/route/agent.ts)、[工具定义](../../agents/route/tools.ts)。
- [资源与 Controller](../../plugins/personal/route/reconcile.ts)、[确定性规则](../../plugins/personal/route/rules.ts)、[持久计划与投递](../../plugins/personal/route/delivery.ts)。
- [宿主工具绑定](../../plugins/personal/aide.ts)、[共享连续调用机制](../../plugins/personal/loop.ts)。

[路由测试](../../tests/route.test.ts)覆盖规则直达、多目标投递、Default、并发到达与部分投递恢复；[Pi SDK 测试](../../tests/pi-agent.test.ts)覆盖真实工具调用、非法目标拒绝、连续上下文、共享记忆与 steer。测试使用模拟模型响应，不能证明真实模型的语义路由准确率。
