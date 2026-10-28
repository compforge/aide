# Route：话题归属与连续分类

## 整体定位

Route 为 Input 寻找一个相关 Topic。明确规则由 Reconcile 执行，其余提交给持续运行的 Route Agent；找不到相关话题才使用 Default。Default 不接受额外的无条件副本，也不承担基础设施故障兜底。

```text
Channel / Source → Input
                   ↓
          Route Reconcile：确定性规则
                   ├─ 命中 ─────────────┐
                   └─ followup → Route Agent → route_input
                                         ↓
                Input.status.topic + route + assess
                                         ↓
                    Topic Reconcile → Chief Agent
                                         ↓ assess_input
                         assess 完成 + handle[Work UID]
                                         ↓
                            Task / Routine Reconcile
```

## CRD

`aide.dev/v1alpha1 Route/global` 是全局协调资源。

### Spec

spec 为空对象；模型、输入预算等策略由 Personal 与 Harness 配置提供。

### Status

agent 保存原生会话引用，execution 保存当前执行。待路由材料、接纳、重试和路由结果保存在 [Input.status.route](input.md#status)，通过索引查询；Route 不复制逐条输入进度。

## Reconciler

### 接纳与确定性规则

`Route/global` 保存当前 execution 与原生 agent 会话引用，待路由事实由 Input 索引提供。默认 Controller 根据 Input 索引发现待路由事实，处理规则；具名 `agent` Controller 把其余输入交给持久 Route Agent。Reconcile 是确定性协调器，Agent 承担非确定性判断。

“持续运行”指复用同一原生上下文，没有输入时可以空闲。空闲时通过 harness verb 的 prompt 启动；运行中，默认 Controller 先保存 Input 的 execution 接纳记录，再经同一个 verb 调用原生 followUp，immediate 则调用 steer。多条 Input 可以在同一 invocation 中分别通过 route_input 完成。明确拒绝才释放接纳记录，结果不确定时保留证据；当前大部分 immediate 带明确 topicKey 或 topicId，会先被规则直接分派。模型等待不阻塞默认 Controller 的规则处理。

规则先处理 Input.topicKey：复用一个可接纳 Topic，缺失时创建独立 ID 的来源 Topic。显式 topicId 用于 Web 选择；新 Web 主题可创建，其他显式引用必须存在。无 key 和显式目标时，可以继承 originalInputId 的稳定归属；否则从 root 候选做语义路由。前置 Input 尚未决定只表示证据缺失，不构成等待依赖。

Channel 与 Source 的同源 key 使用相同规则，详见 [Lark](../connector/lark-messages.md#topic-创建与归属)。有 key 的来源 Topic 不自动获得默认回复地址。规则未命中且没有存活非 Default root 时直接投给 Default；没有 Default 时建立它。

### 恢复、重试与保留

每条 Input.route 保存 executionId、startedAt、attempts、lastError、nextAttemptAt 和最终结果。未完成不等于失败：可能尚未接纳、正在处理、等待退避，或需要核对。纯分类失败可以重试：按每条 Input 的 nextAttemptAt 判断是否就绪，和新输入一起按原始到达顺序选择，避免持续新输入饿死旧失败项。

完成分派的 Input 永远不因 Route 重试而重分派。Chief 已尝试但未确认时可能有外部副作用，保留证据供后续核对，不采用 Route 的自动重试策略。收尾事务失败时，下次 Reconcile 先提交遗留状态和释放 execution，不重复调用 Harness。

Input 自身保护未完成的 route、assess、handle。全部完成后才进入 Host 容量回收候选；Topic 有未完成消费时拒绝删除；Work 显式删除可结束它自己的办理记录，不转给同名新实例。处理凭据随 Input 回收，入站去重回执在配置的窗口内继续防止重投复活。

## Agent

### 工具与完成条件

| 工具 | 用途 |
| --- | --- |
| `list_topics({ offset?, query?, parentUid? })` | 默认返回根主题；支持按名称/摘要搜索，以及某个父主题的直接子节点 |
| `read_input({ inputId?, offset? })` | 分页查看事实或待路由项及尝试记录 |
| `route_input({ inputId, topicUids, reason })` | 原子提交完整路由决定；空目标数组表示 Default |
| `memory_search`、`session_search` | 检索共享记忆与历史 |

`route_input` 仅提供给 Route。工具验证本次 execution 确实接纳了 Input，目标必须是现存 Topic UID。一次事务写入 `Input.status.topic`、`Input.status.route.result`、completedAt 和一条全局空 `assess`；status.topic 是唯一的当前归属，route.result 保存初次路由判断。沿 parentRef 找 root，Weave 归组不搬迁 Input，Chief 可以在树内细化归属；建立 assess 即完成路由，Chief 接纳另由 Topic Reconcile 竞争。目标版本检查与写入处于同一事务，删除或替换目标不能导致误投。

已完成的重复调用不改分派结果、不重置 assess。工具调用成功才表示路由完成；模型结束或说“已分派”不算确认。Chief 使用独立的 `assess_input`，`say` 另行产生 Output。

### 连续上下文与记忆

Route 与 Chief 隔离原生上下文、共用 Hermes 长期记忆；Route 只读检索，Chief 可积累记忆。当前资源事实和用户纠正优先于历史；记忆和外部输入不授予执行权限。原生历史、压缩和恢复由 Harness 管理；Route Operator 在 `status.agent` 保存下次调用所需的配置名和原生会话引用。

### Context View

system 包含助理身份、归属约束与 Route 固定规则；user 背景包含 Me 身份认识和 root 候选，随后是本轮 Input。以下大纲展示动态背景与历史的关系。

#### 上下文组织与优化

每个候选 root 占一个条目：身份 UID，以及有则展示的名称、summary 和近期活动。名称最多 200 字符、summary 最多 2000 字符；近期活动从子树 Input、Work 进展和 Topic Note 中选最近 3 条，每条最多 240 字符。通过归属与父子关系索引查询，自动上下文不加载历史正文；目录同时受分页条数和字符预算限制，缺失详情按需读取。

上下文组织是后续效果优化的重点。固定职责属于 system；会变化的候选信息属于业务背景，以 Pi custom message 投影，LLM 侧是 user；Input 保留为独立 user 消息。当前按以下结构准备每次模型请求，v1 / v2 只表示内容变化，不是 CRD 版本字段：

Route 使用本资源目录下的 [Background](../../plugins/personal/route/background.ts) 保存候选会话快照。每次模型请求前，`background()` 工厂读取最新资源并构造快照；Harness 调用 `Background.text()`，将结果放到 custom → user 的业务前缀。`text()` 只负责文本化，不重新读取资源。共用契约见 [Background 接口](../../agents/background.ts) 和 [Pi 当前业务背景](../harness/pi.md#当前业务背景)。

```text
请求 1
  system：固定 instruction、tools、rules
  custom → user：Background.text()，候选会话快照 v1
    A：UID、名称、Default 标记、summary、有界近期活动
    B：UID、名称、Default 标记、summary、有界近期活动
  user：Input 1
  assistant / tool：route_input(...) 与分派回执

请求 2（会话信息未变）
  system：同上
  custom → user：Background.text()，同一快照 v1
  历史：Input 1、处理与回执
  user：Input 2

请求 3（B.summary 变化）
  system：同上
  custom → user：Background.text()，当前快照 v2 替换前缀中的 v1
  历史：已有对话、处理与回执
  user：Input 3
```

背景前缀在每次模型请求前从资源刷新，覆盖连续调用中的工具后续轮次、followUp 和 steer。内容不变时前缀不变；变化后替换旧材料，不在历史中反复追加快照。它不进入 transcript 或历史摘要，压缩和重启后重新从资源构建。`system.sections` 仍可用于固定系统结构，业务数据不因常驻而成为系统指令。机制见 [Pi 当前业务背景](../harness/pi.md#当前业务背景)。

默认候选来自存活、未处于准备/交接状态的 root Topic，按 UID 稳定排序，每个 summary 最多预览 2000 字符；快照按 20 项和约 16000 个 JSON 字符限制，附 total / nextOffset，通过 list_topics 搜索相关候选或下钻子主题，不要求遍历全目录。fingerprint 按完整投影内容计算，未展示页的变化也会刷新前缀；指纹变化后只重读需要依赖的页面。指纹不持久化，也不表示模型已经阅读。目标提交时仍检查当前资源，名称和 summary 都不授予权限。

没有非 Default 候选时通过确定性规则分派。其它场景的优化重点是：是否反复读取未变的目录、是否遗漏候选变化、是否被旧 summary 误导，以及每条 Input 的模型调用、上下文 token、缓存表现和完成耗时。动态前缀会影响缓存，当前只保证结构和内容稳定，不承诺具体 provider 的缓存命中率。

### 长期演进方向

长期可以借鉴 Jev 的决策模型思路，为 Route 引入专门的 decision model：结合近期 Input、当前 Topic 状态、已确认的分派决定与用户纠正反馈，学习话题归属。历史分派是可修正的决策记录，不自动作为正确标签；模型效果应根据后续反馈验证。

当前由持续复用上下文的 Route Agent 接收 followup，并通过 `route_input` 提交一个相关 Topic；判断没有合适归属时由 Default 承接。未来 decision model 可以辅助候选选择，或在判断足够明确时承接分派决策，沿用 `route_input` 的目标校验、原子分派和幂等确认契约。模型不能明确判断时仍交给 Route Agent；Default 表达没有合适归属的业务决定。此处记录演进方向，当前不引入训练、反馈采集或新的模型后端。

## 配置、实现与验证

`harnesses.route.model` 可单独选择模型，缺省复用 Chief 配置。`plugins.personal.route.contextChars` 限制新输入预览，全文用 read_input 分页读取。见 [配置](../configuration.md#route-连续分类与模型)。

实现入口：[Route Agent](../../agents/route/agent.ts)、[Reconcile](../../plugins/personal/route/reconcile.ts)、[规则](../../plugins/personal/route/rules.ts)、[原子分派](../../plugins/personal/route/delivery.ts)、[持续调用与恢复](../../plugins/personal/loop.ts)。

[路由测试](../../tests/route.test.ts)覆盖规则、Default、并发、单一归属的原子提交 和重试公平性；[研判测试](../../tests/input-assessment.test.ts)覆盖 Work 交接与释放；[SDK 测试](../../tests/pi-agent.test.ts)覆盖工具权限、持久上下文和 steer。模拟模型测试不证明真实语义路由准确率。
