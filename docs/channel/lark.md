# Lark Channel

Lark Channel 把机器人单聊和群内 @机器人的文字接到现有 Personal 请求入口，再把持久消息送回原聊天。它是当前两个 [Channel](README.md) 之一，负责平台协议、收发记录和重连；Chief 负责接话与判断，Task / Routine 由 Personal Plugin 推进。

## 配置机器人

1. 在 [Lark 开发者后台](https://open.feishu.cn/app) 创建企业自建应用，开启机器人能力，设置应用可用范围。Aide 使用单一执行身份；同一应用内的单聊与群聊共用服务端 CLI 能力和凭据，会话划分不提供权限隔离。
2. 开通应用权限 `im:message.p2p_msg:readonly`（读取发给机器人的单聊消息）、`im:message:send_as_bot`（以应用身份发送消息），以及 `cardkit:card:write`（创建与更新流式卡片）。Channel 不依赖 lark-cli 的用户登录态。
   需要群内 @ 接入时，再开通 `im:message.group_at_msg:readonly`（获取群组中用户 @机器人的消息），并将机器人加入目标群；无需开通读取群内所有消息的权限。
3. 在服务器的 `~/.config/aide/env` 填入下面两个变量，执行 `chmod 600 ~/.config/aide/env`，然后重启 Aide。凭证不要提交到仓库或发到聊天中。

   ```dotenv
   AIDE_LARK_APP_ID=cli_your_app_id
   AIDE_LARK_APP_SECRET=your_app_secret
   ```

4. 在日志看到 `Lark WebSocket connected` 后，在开放平台的“事件与回调”选择“使用长连接接收事件”，订阅 `im.message.receive_v1`。
5. 发布应用版本，使权限、机器人能力和事件配置生效。Lark 中找到机器人，发一条文字消息。

服务命令：

```sh
systemctl --user restart aide
journalctl --user -u aide -f
```

本地运行时把相同变量放入进程环境后运行 `npm start`。两个变量都不设则禁用 Lark；只设一个会启动失败。HTTP 服务仍监听本地，不需要暴露公网。需要代理时配置服务的 `HTTPS_PROXY` / `HTTP_PROXY`；WebSocket 也会使用代理。

同一个机器人应用只运行一个消息消费者，避免多个 Aide 或其他机器人程序竞争事件。参考 Lark 官方的[事件订阅配置](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)、[接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)和[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)。

## 收发与恢复

会话标识为 `lark:<App ID>:<chat_id>`。用户身份的 Lark Source 使用独立的 `source:lark:<App ID>:<user_id>:<chat_id>` 话题，观察内容不会自动混入机器人的聊天上下文或出站队列。同一聊天的追问和回答归到同一会话；不同群、单聊、应用和默认网页会话分别匹配工作。群内用户共享该群的上下文，当前不按群成员或话题再拆分。可在网页左侧会话列表选择该聊天，或使用 `/?conversation=lark:<App ID>:<chat_id>` 查看消息与工作，实际会话标识可从收消息日志取得。

服务启动时通过 Lark `/bot/v3/info` 获取当前机器人的 `open_id`。群消息只有在 mentions 中精确包含该身份时才接收，SDK 负责去掉本机器人的 @占位符并保留其他成员的显示名称。普通群消息、@其他机器人、@所有人及机器人发送的消息均忽略；不会将普通聊天注入 Chief 上下文。群内追问的回答也需要 @Aide。

身份查询失败时日志提示群接入已禁用，单聊继续可用；修复访问条件后重启服务重新解析身份。过滤原因写入 debug 日志，接收日志包含 chatType、messageId 和 conversationId，不记录消息正文。

入站事件先保存到 `AIDE_HOME/channels/` 再确认接收，后台依次交给 Aide，避免模型响应超过平台回调时限。Lark 消息 ID 用于去重；未处理的收件在重启后继续。消息提交后异步处理，Chief 失败会保留提示，等待用户核对后新发消息明确重试。已进入业务执行的中断仍遵循 `uncertain` 规则，不自动重放。

出站包括 Chief 回复、业务追问、Task 结果和 Routine 通知，每秒检查持久消息。发送串行，失败后间隔 10 秒重试；长文本分段发送，每段单独记录送达。只有已接收过输入的聊天会收到推送，网页和其他应用的消息不会被转发。群回复沿用同一流式卡片和持久 outbox，发送回原群。

投递记录按消息 ID 保存，不依赖时间游标，避免遗漏稍后写入的消息。发送失败或进程在发送后落盘前退出时，重试沿用相同的 Lark `uuid`。平台的去重窗口有限，超过窗口后仍可能重复送达，不能保证端到端 exactly-once。收发历史暂不自动清理，适用于单用户原型。

## 过程反馈与最终答复

Lark Channel 使用 CardKit JSON 2.0 卡片，遵循 [Channel 的三态展示约定](README.md#回复展示状态)。卡片外层默认展开，内部包含「过程」和「回答」，各自有可见预览及原生折叠详情。执行中，最新思考与当前工具各占最多一行；回答展示最新正文节选，最多三行。完成后，过程显示结果概况，回答切换为开头三行。客户端按实际宽度截断并显示省略号；正文预览是纯文本，详情保留 Markdown。

原生折叠操作由 Lark 客户端控制。内容更新只修改有稳定 ID 的文本组件，并调整 streaming_mode，不重建折叠面板或重新写入 expanded；用户查看详情时，流式输出、结束及问答续轮都保留其选择。等待回答与中断提示取消预览行数限制，使需处理的信息可见。进行中的回答节选取最近文本，Lark 负责三行截断；完整文字同时积累在详情区域。

每秒合并当前内容，所有更新串行复用官方 SDK 客户端、凭证和超时。同一张卡片共享持久化递增 sequence，卡片 ID、发送 uuid 与已更新组件内容保存到 Channel 状态；重启或重试继续更新同一卡片。仅在旧布局卡片恢复时做一次布局替换，之后使用组件局部更新。

结束或等待用户时关闭 streaming_mode，更新最终正文与预览后才确认业务 Message 已投递。用户回答 Chief 问题后，继续更新原卡片。过程反馈不写入业务 Message，不改变工作状态。卡片失败时保留最终文本投递；超长答复沿用分段文本完整发送，卡片过程受平台体积预算限制，完整执行记录可在 Web 查看。Task / Routine 的异步通知继续走文本 outbox。

需要额外开通 `cardkit:card:write` 并发布应用，客户端需支持 Card JSON 2.0。协议依据：[创建卡片实体](https://open.feishu.cn/document/cardkit-v1/card/create)、[流式更新文本](https://open.feishu.cn/document/cardkit-v1/card-element/content)、[更新卡片配置](https://open.feishu.cn/document/cardkit-v1/card/settings)、[批量局部更新](https://open.feishu.cn/document/cardkit-v1/card/batch_update)、[全量更新](https://open.feishu.cn/document/cardkit-v1/card/update)。

## 验证与边界

发“先问我的称呼，收到回答后写一句问候”，应收到 Chief 追问；回复称呼后收到问候，无需创建事项。需要验证持久工作时明确交办 Task，并核对工作状态和结果。再交办一个定期检查任务，关闭网页后等待 Lark 通知；重启 Aide 后，已送达消息不应重新发送。

自动测试覆盖真实 Plugin Worker 下的单聊问答，以及收件恢复、去重、异步通知、发送失败补投和消息隔离；SDK 传输使用替身。长连接建立、应用权限和真实 Lark 投递必须用已配置的机器人验收。`/health` 成功只证明 HTTP 服务存活，`channel started` 也不等于连接成功。

当前接收用户单聊文字与群内 @本机器人的文字；已寻址的非文字消息或空文字会提示改发有效文字。Codex 的原生工具授权和 Hook 信任仍到网页处理；Lark 文字不会被当作这些授权的自动确认。图片与卡片入站、多账号和通用 Channel SDK 暂不提供。

Chief 的 ask/confirm 可在原聊天作答，群内回答需 @Aide；明确回复“确认”或“拒绝”处理确认问题。自由问题直接回复文字。一次只有一个待答问题；Hooks 信任和工具权限仍通过网页处理。详见 [Personal](../plugin/personal.md)。

流式协议测试覆盖真实 SDK 请求、积累文本与递增序号、问答续轮、重启去重、更新失败回退、超长答复，以及真实 Harness 投影中的思考和正文增量；网络与模型使用替身。真实效果需在已授权机器人上验收：发起需多次工具调用的问题，观察处理状态、思考和正文变化，完成后检查过程折叠、最终答案不重复，再验证追问和中断。

群聊自动测试覆盖真实 SDK mention 解析、精确身份匹配、清理占位符、其他人名保留、并发重复事件、重启恢复与群/单聊隔离。真实验收还需在目标群 @Aide，核对事件收到、进入 Chief、卡片送回原群；随后发送不 @、@其他机器人和 @所有人的消息，确认不触发新的 Chief 输入。截图或替身测试不代替这项群聊现场验证。
