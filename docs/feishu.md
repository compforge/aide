# 飞书 Channel

飞书 Channel 把机器人单聊接到现有 Personal 请求入口，再把持久消息送回原单聊。它负责平台协议、收发记录和重连；Chief 负责接话与判断，Task / Routine 由 Personal Plugin 推进。

## 配置机器人

1. 在 [飞书开发者后台](https://open.feishu.cn/app) 创建企业自建应用，开启机器人能力，把应用可用范围设为自己。当前 Aide 是单用户原型，同一应用内的所有单聊共享执行身份和 CLI 能力。
2. 开通应用权限 `im:message.p2p_msg:readonly`（读取发给机器人的单聊消息）和 `im:message:send_as_bot`（以应用身份发送消息）。Channel 不依赖 lark-cli 的用户登录态。
3. 在服务器的 `~/.config/aide/env` 填入下面两个变量，执行 `chmod 600 ~/.config/aide/env`，然后重启 Aide。凭证不要提交到仓库或发到聊天中。

   ```dotenv
   AIDE_FEISHU_APP_ID=cli_your_app_id
   AIDE_FEISHU_APP_SECRET=your_app_secret
   ```

4. 在日志看到 `Feishu WebSocket connected` 后，在开放平台的“事件与回调”选择“使用长连接接收事件”，订阅 `im.message.receive_v1`。
5. 发布应用版本，使权限、机器人能力和事件配置生效。飞书中找到机器人，发一条文字消息。

服务命令：

```sh
systemctl --user restart aide
journalctl --user -u aide -f
```

本地运行时把相同变量放入进程环境后运行 `npm start`。两个变量都不设则禁用飞书；只设一个会启动失败。HTTP 服务仍监听本地，不需要暴露公网。需要代理时配置服务的 `HTTPS_PROXY` / `HTTP_PROXY`；WebSocket 也会使用代理。

同一个机器人应用只运行一个消息消费者，避免多个 Aide 或其他机器人程序竞争事件。参考飞书官方的[事件订阅配置](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)、[接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)和[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)。

## 收发与恢复

会话标识为 `feishu:<App ID>:<chat_id>`。同一单聊的追问和回答归到同一会话；不同应用、不同单聊以及默认网页会话分别匹配工作。在网页使用 `/?conversation=feishu:<App ID>:<chat_id>` 可查看对应事项，实际会话标识可从收消息日志取得。

入站事件先保存到 `AIDE_HOME/channels/` 再确认接收，后台依次交给 Aide，避免模型响应超过平台回调时限。飞书消息 ID 用于去重；未处理的收件在重启后继续。消息提交后异步处理，Chief 失败会保留提示，等待用户核对后新发消息明确重试。已进入业务执行的中断仍遵循 `uncertain` 规则，不自动重放。

出站包括接单回复、业务追问、Task 结果和 Routine 通知，每秒检查持久消息。发送串行，失败后间隔 10 秒重试；长文本分段发送，每段单独记录送达。只有已接收过消息的单聊会收到推送，网页和其他应用的消息不会被转发。

投递记录按消息 ID 保存，不依赖时间游标，避免遗漏稍后写入的消息。发送失败或进程在发送后落盘前退出时，重试沿用相同的飞书 `uuid`。平台的去重窗口有限，超过窗口后仍可能重复送达，不能保证端到端 exactly-once。收发历史暂不自动清理，适用于单用户原型。

## 验证与边界

发“先问我的称呼，收到回答后写一句问候”，应依次收到接单回复和追问；回复称呼后，同一事项完成并收到结果。再交办一个定期检查任务，关闭网页后等待飞书通知；重启 Aide 后，已送达消息不应重新发送。

自动测试覆盖真实 Plugin Worker 下的单聊问答，以及收件恢复、去重、异步通知、发送失败补投和消息隔离；SDK 传输使用替身。长连接建立、应用权限和真实飞书投递必须用已配置的机器人验收。`/health` 成功只证明 HTTP 服务存活，`channel started` 也不等于连接成功。

当前只接收用户单聊文字，其他消息类型会提示改发文字，群聊与机器人消息忽略。Codex 的原生工具授权和 Hook 信任仍到网页处理；飞书文字不会被当作这些授权的自动确认。图片、卡片、群聊、多账号和通用 Channel SDK 暂不提供。

Chief 的 ask/confirm 可直接在单聊作答；明确回复“确认”或“拒绝”处理确认问题。自由问题直接回复文字。一次只有一个待答问题；Hooks 信任和工具权限仍通过网页处理。详见 [Chief](chief.md)。
