# 网页实时进展

网页把聊天记录和当前执行进展分开呈现。接收 Input 后显示排队或处理状态，Chief 执行时显示 Harness 返回的思考内容、工具名称及状态、逐步生成的回复正文；完成后由正式 Message 接替。模型未提供思考内容时只显示真实状态，不生成占位思考文本。当前覆盖 Chief 接话过程，Work 的后台执行仍通过事项卡片展示状态。

```text
Pi SDK delta / tool event → Pi Adapter → Core Event → Session Projection
                                                        ↓
Conversation / Input / Message → conversationView → SSE → 网页
```

Pi Adapter 将 `text_delta` / `thinking_delta` 映射到现有 `agent_message_chunk` / `agent_thought_chunk`，消息结束时使用相同 ID 提交完整内容。工具循环的中间发言保持 commentary，只有成功收口的最后答复标为 final。展示进展不改变 Harness 的完成语义，也不触发 Work CRUD。

`src/channel/view.ts` 从已有 Session Projection 选择当前 Conversation 的 Chief Target 和活跃 Turn，只输出其 agent / thought / tool 内容，不发送内部提示词或整个工具原始响应。`src/channel/stream.ts` 通过 `GET /stream?conversationId=...` 发送具名 `view` SSE 事件，每次是完整的 messages / activity 快照。首次连接和重连都从当前投影生成快照，浏览器直接替换，不重放业务操作，也不累加重复文本。

流式变更按 100 ms 合并，空闲连接每 15 秒发送心跳，Work 独立写入的 outbox 每 1.5 秒检查一次。发送阻塞时等待 drain，只保留最新投影；断开连接清理订阅和计时器，不取消服务端执行。服务退出时关闭 SSE 连接。网页只更新进展节点的文字，保留展开状态、输入焦点和用户浏览历史时的滚动位置。

这一结构参考 AgentUE 的状态快照和 SSE 传输边界，以及 Baton / chat-tui 将事实、展示投影、Activity 分开的方式。Aide 已有 Core reducer，所以不额外接入另一套 reducer 或复制终端组件；当前 SSE 是 Aide 自己的快照接口，不声明实现完整 AgentUE 协议。

进度不写入 Channel 出站 Message，因此不会让飞书收到逐 token 消息。完成后的网页仍保留正式答复；执行过程的原始事件保存在既有 Session Ledger，此版没有增加网页历史轨迹查看器。

`tests/pi-agent.test.ts` 使用真实 Pi SDK 和受控模型 SSE，验证完成前已有思考和正文增量、最终文本不重复。`tests/web-progress.test.ts` 使用真实 Host / Runner / HTTP 和模拟 Harness，验证会话隔离、执行中可见、重连恢复、断开不取消、最终消息替换，以及进度不进入出站消息。
