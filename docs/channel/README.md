# Channel

Channel 是 Aide 与用户沟通的入口和出口，负责接收消息、确定会话范围、提交输入并投递回复。当前有两个 Channel：Web 和 Feishu。它们接入同一套 Personal 业务，Chief 负责理解与判断，Task / Routine 负责持续工作。

| Channel | 输入与会话划分 | 输出与交互 |
| --- | --- | --- |
| [Web](web.md) | URL 选择 conversationId，左侧列表切换已有会话 | 消息、流式进展、历史执行、事项与安排；回答问题和原生 Harness 请求 |
| [Feishu](feishu.md) | 应用 ID + chat ID 确定会话；接收单聊与群内 @本机器人 | 流式卡片展示 Chief 思考与回复、问答续轮、工作结果与安排通知，送回原聊天 |

## 输入、会话与回复

Channel 提交用户消息时提供稳定 sessionId、conversationId 与消息去重身份；同一上下文沿用 sessionId，Core 按它创建或恢复执行作用域。新 Conversation 可以直接沿用 sessionId。Host 持久化 Message 和引用它的 Input，先返回接收回执，再由 Chief 异步处理。接收成功不代表模型已经回答，更不代表目标已完成。

Channel 决定自己的原生会话如何映射为 Conversation，不决定创建 Task 还是 Routine。Chief 普通回答直接进入消息流，需要跟进时才操作 Work。同一会话后续消息可以回答问题或补充已有工作。

Source 也能提交 Input，但属于外部观察入口。它可使用独立 Conversation，或明确路由到已有 Channel 会话。Conversation 不由某一个页面独占：Web 可以查看飞书或 Source 会话，并从会话列表读取其 sessionId，继续提交到原 Session；回复是否送达飞书由 Feishu 的已有会话路由决定。

当前会话划分用于组织上下文与工作，所有 Channel 共用单用户执行身份和 CLI 能力，不提供多用户权限隔离。

## 投递与进度

正式回复与工作结果是持久 Message，Channel 按自己的投递记录发送。失败重试不应重新执行已经完成的业务。客户端断开也不取消服务端 Task / Routine。

思考、工具调用和文字增量属于执行进展，来自 Harness 事件与 Ledger 投影。Web 使用 Markdown 展示；Feishu 使用原生流式卡片，合并更新思考与正文，最终收口到同一张卡片。进展不写成新的用户 Input，也不触发 Work。

Chief 的问答可通过两个 Channel 回答。当前原生 Harness 授权和 Hook 信任通过 Web 处理；网页按 Conversation 筛选已关联的问题，未关联会话的宿主交互保留在本地收件区。

## 扩展边界

新的 Channel 需要解决平台消息接收、会话映射、去重与回复投递，并复用已有输入与交互入口。业务判断留在插件，Agent 执行留在 Harness。当前使用具体适配器，尚未抽取通用 Channel SDK。

内核对象与持久化见 [Kernel](../kernel.md)，Personal 判断流程见 [Personal](../plugin/personal.md)，部署见 [部署与诊断](../deployment.md)。

Channel 通过 `src/channel/service.ts` 的输入与投影接口接入应用，不依赖 Personal 或 Chief 的实现。Web 的 HTTP handler 位于 `src/api/`，通过扩展接口 `src/api/service.ts` 使用应用提供的 Work 侧栏、删除与事件能力；浏览器代码位于 `src/web/`。
