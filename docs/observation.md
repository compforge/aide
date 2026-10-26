# Observation：从 Input 跟进到原生 Session

一个 Input 的处理过程对应一个 JobView；一个原生 agent loop Session 对应一个 SessionView。两种视角都采用 agent-ledger Observation 模型，可以交给 trajectory skill 分析失败原因、冗余开销和上下文组织。

## 业务证据与执行证据

Job ID 是 Input UID，来源为 `aide.input`。Input.status 的 route、assess、handle 保存当前处理回执，接纳时记录 `agent` 原生引用；完成处理的工具记录 `completedBy`，包含 harness、sessionId、executionId、toolCallId。接纳执行与确认执行分开：后一次执行可以核对前一次中断后留下的效果。

Output 保存 `createdBy` 和明确关联 Input 的 UID。一个 Output 可以关联多个 Input，也可以没有 Input；关联表示来源，不代表完成处理。JobView 从这些事实生成路由、研判、办理和投递 Operation，再关联确认工具及其直接产生者 ModelCall。原生 Session 中其它调用不自动归到这个 Job。重复 tool call ID 无法唯一定位时标明缺口，不按文本或时间猜测。

同一个 ModelCall 可能处理多个 Input，因此可以出现在多个 Job 中，不能将其成本跨 Job 直接累加。Job 的 completed 只表示 Input 处理回执已完成；Work 目标达成、Output 投递成功分别看各自记录。静默处理不要求 Output。

SessionView 保留完整原生上下文，适合检查 prompt、工具调用和连续 followup。Input UID、消费者 UID 和原生 Session 引用不依赖消费者仍然存在。资源回收、Session 清理、缺少请求补录或记录不完整都显式呈现为 issues；当前回执不冒充完整重试历史。

## 查看与导出

Web → Inputs → 选择 Input → Observation：查看 JobView 或关联的 Session，下载对应 JSON。HTML 使用 agent-observation 的静态 renderer，内容转义，不执行原生记录中的代码。

- `GET /inputs/job?id=<Input name>&uid=<Input UID>`：`agent-ledger/job@1`。
- `GET /inputs/session?id=...&uid=...&harness=chief&sessionId=...`：`agent-ledger/session@1`。
- `format=html` 返回独立 HTML；`download=1` 下载快照。

Session 读取必须匹配该 Input 或其显式关联 Output 保存的引用，不接受任意文件路径。导出是按需快照，不再写一套全局执行日志。模型 Session 可能包含多个 Input 的上下文，分享前按实际内容选择范围。

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
