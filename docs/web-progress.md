# 网页实时进展

网页把聊天记录和当前执行进展分开呈现。接收 Input 后显示排队或处理状态，Chief 执行时显示 Harness 返回的思考内容、工具名称及状态、逐步生成的回复正文；完成后显示正式 Message，并将该轮过程折叠为“查看思考与执行过程”。模型未提供思考内容时只显示真实状态，不生成占位思考文本。当前覆盖 Chief 接话过程，Work 的后台执行仍通过事项卡片展示状态。

```text
Pi SDK delta / tool event → Pi Adapter → Core Event → Session Projection
                                                        ↓
Conversation / Input / Message → conversationView → AgentUE UIModel
                                                        ↓
                          PatchEmitter → encodeSse → 浏览器 applyPatch → 网页
```

Pi Adapter 将 `text_delta` / `thinking_delta` 映射到现有 `agent_message_chunk` / `agent_thought_chunk`，消息结束时使用相同 ID 提交完整内容。工具循环的中间发言保持 commentary，只有成功收口的最后答复标为 final。展示进展不改变 Harness 的完成语义，也不触发 Work CRUD。

`src/channel/view.ts` 从已有 Session Projection 选择当前 Conversation 的 Chief Target 及其全部 Turn，不发送内部提示词或整个工具原始响应。它生成 `biz: aide.conversation` 的 AgentUE UIModel：`meta.conversation_id` 和 `meta.activity` 表示会话与当前执行状态，正式 `message` 和每个 Turn 对应的 `execution` 按时间排序；`thought` / `text` / `tool` 通过 `parent_id` 归属到该 execution，内部保持 Ledger 时间线顺序。不同类别的 ID 有前缀，避免业务消息与执行事件的身份冲突。

`src/channel/stream.ts` 使用 SDK 的 `PatchEmitter` 和 `encodeSse`，通过 `GET /stream?conversationId=...` 输出 AgentUE SSE。首次连接与重连发送 `start` 完整快照，之后新增或更正 block 用 `set`，正文增长用 `append`，执行状态变化用 `meta.activity` 的 `set`。完成只改变 execution 状态，不移除其内容；消息插入导致 block 顺序变化时发送新的 `start` 替换模型。

流式变更按 100 ms 合并，空闲连接每 15 秒发送 AgentUE `ping`，Work 独立写入的 outbox 每 1.5 秒检查一次。发送阻塞时等待 drain，基于上次已写出的模型计算最新 patch。每个连接最长持续 5 分钟，以 `end` 正常结束，由 EventSource 自动重连；投影失败发送 `error` 后 `end`。首次投影失败则直接返回 HTTP 500。断开连接清理订阅和计时器，不取消服务端执行；进程退出或网络中断属于传输中断，客户端从新快照恢复。

依赖固定为已发布的 `@compforge/agentue@0.0.1`，使用它的协议 1.0。服务端与浏览器直接引用同一 SDK，不复制协议实现。`web-sdk.ts` 仅导出浏览器所需的 `applyPatch` / `parsePatchEvent`，由现有 Bun 在首次请求时打包并缓存，经同源 `/agentue.js` 提供。浏览器按 SDK reducer 更新展示模型，Aide 负责将 block 渲染到页面并保留展开状态、输入焦点和用户浏览历史时的滚动位置。

Core reducer 负责执行事实，AgentUE reducer 负责展示状态，二者职责独立。Baton / chat-tui 仅作为事实与 View 分层的理念参考，没有引入终端 UI。每次连接的 seq 属于该次交付，不保存 UI patch 日志或按 Last-Event-ID 重放；执行事件仍由既有 Ledger 持久化。

进度不写入 Channel 出站 Message，因此不会让飞书收到逐 token 消息。历史过程直接从既有 Session Ledger 重放形成的投影读取，没有另一份轨迹存储。执行时展开实时内容，结束后默认折叠；同页后续消息更新保留用户的展开选择。刷新或重启后仍可展开查看旧轮次，未正常结束的执行标为中断。

`tests/pi-agent.test.ts` 使用真实 Pi SDK 和受控模型 SSE，验证完成前已有思考和正文增量、最终文本不重复。`tests/web-progress.test.ts` 使用真实 Host / Runner / HTTP 和模拟 Harness，下载 HTTP 提供的浏览器 bundle，用其真实 AgentUE reducer 消费 SSE，验证会话隔离、增量更新、重连恢复、断开不取消、最终答复与过程历史同时保留、后续轮次分组、重开 Aide 后的 Ledger 恢复、错误收口，以及进度不进入出站消息。
