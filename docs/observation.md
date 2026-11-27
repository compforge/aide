# Observation：从 Input 跟进到原生 Session

一个 Input 的处理过程对应一个 JobView；一个原生 agent loop Session 对应一个 SessionView。两种视角都采用 agent-ledger Observation 模型，可以交给 trajectory skill 分析失败原因、冗余开销和上下文组织。

## 业务证据与执行证据

Job ID 是 Input UID，来源为 `aide.input`。Input.status 的 route、assess、handle 保存当前处理回执，接纳时记录 `agent` 原生引用；完成处理的工具记录 `completedBy`，包含 harness、sessionId、executionId、toolCallId。接纳执行与确认执行分开：后一次执行可以核对前一次中断后留下的效果。

Output 保存 `createdBy` 和明确关联 Input 的 UID。`createdBy` 只来自发起该 Output 的明确 agent execution，并固定为首次接纳时的事实；重试沿用原值，包括原本没有该字段的情况。系统恢复通知没有 agent execution，不借用 Topic 中恰好活跃的 Chief，也不把通知去重键当作 tool call ID。一个 Output 可以关联多个 Input，也可以没有 Input；关联表示来源，不代表完成处理。JobView 从这些事实生成路由、研判、办理和投递 Operation，再关联确认工具及其直接产生者 ModelCall。原生 Session 中其它调用不自动归到这个 Job。重复 tool call ID 无法唯一定位时标明缺口，不按文本或时间猜测。

同一个 ModelCall 可能处理多个 Input，因此可以出现在多个 Job 中，不能将其成本跨 Job 直接累加。Job 的 completed 只表示 Input 处理回执已完成；Work 目标达成、Output 投递成功分别看各自记录。静默处理不要求 Output。没有路由回执时不生成路由 Operation，也不判定 Job 已完成；尚未开始的处理投影为 unknown，等待状态通过已有分派事实和 issues 说明。

SessionView 保留完整原生上下文，适合检查 prompt、工具调用和连续 followup。Input UID、消费者 UID 和原生 Session 引用不依赖消费者仍然存在。资源回收、Session 清理、缺少请求补录或记录不完整都显式呈现为 issues；当前回执不冒充完整重试历史。

## 查看与导出

Web → Inputs → 选择 Input → Observation：查看 JobView 或关联的 Session，下载对应 JSON。HTML 使用 agent-observation 的静态 renderer，内容转义，不执行原生记录中的代码。

- `GET /inputs/job?id=<Input name>&uid=<Input UID>`：`agent-ledger/job@1`。
- `GET /inputs/session?id=...&uid=...&harness=chief&sessionId=...`：`agent-ledger/session@1`。
- `format=html` 返回独立 HTML；`download=1` 下载快照。

未装配 Session reader 时，JobView 保留业务证据并注明读取能力缺失，Session 端点返回 unavailable（404）。Session 读取必须匹配该 Input 或其显式关联 Output 保存的引用，不接受任意文件路径。导出是按需快照，不再写一套全局执行日志。模型 Session 可能包含多个 Input 的上下文，分享前按实际内容选择范围。

## 原生存储与可选请求补录

Pi 原生 Session 是输入正文、模型响应、工具结果与恢复的事实源。Aide 不复制这些正文。`@compforge/agent-pi/observation` 负责将原生记录投影为 SessionView。

Pi 的原生历史不能重建每次调用实际使用的 system、tools、可变 Background 和 provider payload。需要分析这些内容时，可在 Aide 配置开启补录：

```yaml
observation:
  captureRequests: true
  maxSessionBytes: 16777216  # 单 Session 补录上限，默认 16 MiB
  maxBytes: 268435456       # 所有补录文件总预算，默认 256 MiB
```

`captureRequests` 默认关闭。开启后，补录写到 `$AIDE_HOME/observations/pi/` 的压缩 JSONL，只保存原生历史没有的请求、运行时标记和关联引用，不包含重复的响应或工具结果正文。请求本身包含上下文，因此仍有额外磁盘开销；文件按 0600 创建。

活跃 Session 预留容量，非活跃文件按实际字节计入总预算。预算耗尽或写入失败只停止补录并记录告警，不阻断业务执行；不自动删除已有证据。停止服务后可清理补录目录腾出预算，不影响 Pi 恢复。该预算不负责清理 Pi 自己的原生 Session。

关闭补录、provider 不支持 payload hook、达到容量上限或部分文件损坏时，导出仍以原生证据为准，并注明缺口。provider payload 是最终 hook 的返回值，不宣称是网络线上字节。

## Agent Usage

Usage 有总览、角色、模型三个视图，共用滚动 24 小时或 7 天窗口。总览展示已观测 tokens、调用次数、按记录时间归入自然分钟的用量和角色占比。分钟峰值反映 Aide 收到的用量记录，provider 的限流窗口和计数口径由其独立决定。模型视图可以按 provider/model 进入角色用量。角色详情展示所选范围内用量最高的 20 个 Session，支持分页查看调用和打开原生 SessionView；Chief 详情按触发来源分组，Route 详情在有成功回执时展示路由效率。

Gate、Route、Chief、Weave、Task、Routine 运行时，Host 在 Pi 追加带用量的条目后把计数写入 `$AIDE_HOME/usage.sqlite`。记录包含时间、角色、模型、Session ID、entry ID 和可用的触发来源。计量身份为 Session ID 和原生 entry ID。多个 Input 共享一次模型调用时，这次用量只计一次。报表与调用明细查询 SQLite。原生 SessionView 仍按需读取 Pi 文件。用量统计独立于 `captureRequests`，数据从升级后首次调用开始积累。

- 每条原生 Assistant 响应计一次可观测调用，包括有用量的失败响应。窗口按原生记录时间确定。有用量的调用数除以可观测调用数表示覆盖率，缺失或全零 usage 的响应保留在分母中。provider 未返回记录的尝试无法从 Session 还原。
- Input、Output、Cache read、Cache write 使用 Pi 适配器归一化的计数。单次输入规模为 Input 加 Cache read 和 Cache write，P50、P95 取有计数的响应。压缩、分支摘要和缓存预热等原生辅助记录中显式报告的用量也计入 token 总量，另列辅助 token。单条摘要可能涵盖多次请求，辅助记录单独展示类型。模型未记录时显示 unknown。
- Chief 在 provider 请求准备阶段标记当前任务来源，Host 记录响应时把该来源一并写入 SQLite。不同业务渠道均归入普通 Input。混合来源和无法归属的调用单列。
- Route 的分母取窗口内成功的 route_input 回执，按 Input ID 去重。平均值为同一窗口 Route 的已观测 tokens 除以成功路由的 Input 数。跨窗口推进会影响该比值，按模型筛选时只展示模型本身的用量。
