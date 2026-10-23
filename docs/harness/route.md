# Route Harness

Route 为 Input 寻找一个或多个相关 Conversation。明确规则由 Reconcile 执行，其余提交给持续运行的 Route Agent；找不到相关话题才使用 Default。Default 不接受额外的无条件副本，也不承担基础设施故障兜底。

```text
Channel / Source → Input
                   ↓
          Route Reconcile：确定性规则
                   ├─ 命中 ─────────────┐
                   └─ followup → Route Agent → route_input
                                         ↓
                Input.status.route + assess[Conversation UID]
                                         ↓
                    Conversation Reconcile → Chief Agent
                                         ↓ assess_input
                         assess 完成 + handle[Work UID]
                                         ↓
                            Task / Routine Reconcile
```

## Agent 与 Controller

`Route/global` 只保存当前 execution，不保存 Input ID 队列。默认 Controller 根据 Input 索引发现待路由事实，处理规则；具名 `agent` Controller 把其余输入交给持久 Route Agent。Reconcile 是确定性协调器，Agent 承担非确定性判断。两者不需要 Batch 或 Delivery 资源。

“持续运行”指复用同一原生上下文，普通输入持续 followup；没有输入时可以空闲。运行中的 immediate 可以通过 steer 接纳。当前大部分 immediate 带明确 sessionId，会先被规则直接分派。模型等待不阻塞默认 Controller 的规则处理。

规则匹配 Input.sessionId 与 Conversation 话题；originalInputId 已有路由结果时可以沿其归属关联。前置 Input 尚未决定时，它只是证据，不构成硬等待依赖。Channel 的明确新话题可以创建 Conversation，Source 的陌生话题线索本身不创建。没有任何 Conversation 时直接建立 Default。

## 工具与完成条件

| 工具 | 用途 |
| --- | --- |
| `list_conversations({ offset? })` | 当前会话 UID、名称、Default 标记与摘要 |
| `read_input({ inputId?, offset? })` | 分页查看事实或待路由项及尝试记录 |
| `route_input({ inputId, conversationUids, reason })` | 原子提交完整路由决定；空目标数组表示 Default |
| `memory_search`、`session_search` | 检索共享记忆与历史 |

`route_input` 仅提供给 Route。工具验证本次 execution 确实接纳了 Input，目标必须是现存 Conversation UID。一次事务写入 `Input.status.route.result`、completedAt 和所有 `assess[uid]`；建立 assess 即完成交付，不再逐个修改 Conversation 队列。目标版本检查与写入处于同一事务，删除或替换目标不能导致误投。

已完成的重复调用不改分派结果、不重置 assess。工具调用成功才表示路由完成；模型结束或说“已分派”不算确认。Chief 使用独立的 `assess_input`，`say` 另行产生 Output。

## 恢复、重试与保留

每条 Input.route 保存 executionId、startedAt、attempts、lastError、nextAttemptAt 和最终结果。未完成不等于失败：可能尚未接纳、正在处理、等待退避，或需要核对。纯分类失败可以重试：按每条 Input 的 nextAttemptAt 判断是否就绪，和新输入一起按原始到达顺序选择，避免持续新输入饿死旧失败项。

完成分派的 Input 永远不因 Route 重试而重分派。Chief 已尝试但未确认时可能有外部副作用，保留证据供后续核对，不采用 Route 的自动重试策略。收尾事务失败时，下次 Reconcile 先提交遗留状态和释放 execution，不重复调用 Harness。

Input 自身保护未完成的 route、assess、handle。全部完成后才进入 Host 容量回收候选；目标删除会把未完成的对应阶段标为 cancelled，不转给同名新实例。处理凭据随 Input 回收，入站去重回执在配置的窗口内继续防止重投复活。

## 连续上下文与记忆

Route 与 Chief 隔离原生上下文、共用 Hermes 长期记忆；Route 只读检索，Chief 可积累记忆。当前资源事实和用户纠正优先于历史；记忆和外部输入不授予执行权限。原生历史、压缩和恢复由 Harness 管理；Route 的 `status.agent` 只保存 Harness、Target 与原生会话引用。

## 长期演进方向

长期可以借鉴 Jev 的决策模型思路，为 Route 引入专门的 decision model：结合近期 Input、当前 Conversation 状态、已确认的分派决定与用户纠正反馈，学习话题归属。历史分派是可修正的决策记录，不自动作为正确标签；模型效果应根据后续反馈验证。

当前由持续复用上下文的 Route Agent 接收 followup，并通过 `route_input` 提交一个或多个相关 Conversation；判断没有合适归属时由 Default 承接。未来 decision model 可以辅助候选选择，或在判断足够明确时承接分派决策，沿用 `route_input` 的目标校验、原子分派和幂等确认契约。模型不能明确判断时仍交给 Route Agent；Default 表达没有合适归属的业务决定。此处记录演进方向，当前不引入训练、反馈采集或新的模型后端。

## 配置、实现与验证

`harnesses.route.model` 可单独选择模型，缺省复用 Chief 配置。`plugins.personal.route.contextChars` 限制新输入预览，全文用 read_input 分页读取。见 [配置](../configuration.md#route-连续分类与模型)。

实现入口：[Route Agent](../../agents/route/agent.ts)、[Reconcile](../../plugins/personal/route/reconcile.ts)、[规则](../../plugins/personal/route/rules.ts)、[原子分派](../../plugins/personal/route/delivery.ts)、[持续调用与恢复](../../plugins/personal/loop.ts)。

[路由测试](../../tests/route.test.ts)覆盖规则、Default、并发、原子 fanout 和重试公平性；[研判测试](../../tests/input-assessment.test.ts)覆盖 Work 交接与释放；[SDK 测试](../../tests/pi-agent.test.ts)覆盖工具权限、持久上下文和 steer。模拟模型测试不证明真实语义路由准确率。
