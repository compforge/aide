# Lark 消息观察

用户收到的单聊、群内明确 @ 用户的消息，以及所在群的新消息，都是可以交给 Personal 判断的外部输入场景。
Source 保存观察事实，Chief 结合用户已有委托选择提醒、询问、关联工作或忽略。
当前实现支持 `direct`（别人发给用户的单聊）和 `mention`（群内明确 @ 用户），没有启用全群新消息观察。

## 接入与权限

Host 通过服务进程 PATH 中的 `lark-cli` 读取消息，使用服务用户 HOME 下已有的登录态。需要在运行 Aide 的机器上完成用户授权。
每次读取前核对 `appId` 和 `userId`，防止 CLI 切换账号后继续使用旧观察水位。用户 ID 是该应用下的 `open_id`。
配置不包含 token，Runner 不接收凭证，CLI 请求显式使用 `--as user`。

```yaml
connectors:
  lark:
    appId: cli_your_app
    userId: ou_your_open_id
    timeoutMs: 20000
plugins:
  personal:
    messages:
      kinds: [direct, mention]
```

省略 `plugins.personal.messages` 或设置 `kinds: []` 不启动观察；只声明 Connector 时，Chief 仍可按需读取上下文。
已有 Lark Channel 的机器人交互不受此配置影响。初次启用默认观察最近五分钟，不导入全部历史。
应先建立自己的 Aide Conversation，并按需要设为默认联系人；没有可承接的 Conversation 时，现有路由会记录 ignored。
观察源位于独立执行 Session `source:lark-messages`，新聊天 Session 不会重复启动它；Input 不预设目标 Session 或 Conversation。

| 操作 | 权限 |
|---|---|
| 消息搜索 | `search:message` |
| 消息基础读取 | `im:message:readonly`（或已获批的 `im:message`） |
| 用户身份群聊读取 | `im:message.group_msg:get_as_user` |
| 用户身份单聊读取 | `im:message.p2p_msg:get_as_user` |
| 搜索结果补充群信息 | `im:chat:read` |

应用权限、用户授权和会话可见性需同时满足。群历史可见设置、保密模式、外部群和应用类型仍可能限制访问。
参考 [获取会话历史消息](https://open.feishu.cn/document/server-docs/im-v1/message/list)。
表情回复与附件下载不属于默认读取过程，不为它们申请额外权限。

## 消息与上下文

Connector 提供消息搜索、群历史和话题回复的分页读取，查询条件与 Personal 触发策略分离。
消息保留发送人、群、原消息 ID、时间、mentions、可用的回复与话题关联及原消息链接。
`--is-at-me` 也可能命中 `@所有人`，Source 必须检查结构化 mentions 中的用户 ID。
两个场景均排除用户自己发送的、机器人发送的和已撤回的消息。

初次观察读取有限的前后文；话题优先取话题回复，并从附近群历史寻找根消息。
上下文字段 `observedThrough` 表示查询截至时间，`truncated` 表示不完整，`error` 表示读取失败，
`missingRoot` 标记话题根消息缺失。Chief 使用 `read_chat_messages` / `read_thread_messages` 按需继续读取。
CLI compact 时间可能只有分钟精度，Connector 固定进程时区为 UTC 后归一；上下文边界保留一分钟余量，
不能据此判断同一分钟内的精确先后顺序。

每条原消息生成一个稳定 Input，`observation.kind` 为 `direct` 或 `mention`。
单聊的每条新消息各自触发发现。群内 @ 在发现后继续观察短窗口，同话题或可识别的回复链出现新消息时，
追加 `discussion` Input，携带 `originalMessageId` 和 `originalInputId`。无关群消息不会仅因时间相近触发跟进。
再次明确 @ 用户的消息由其自己的发现 Input 承接。窗口结束后停止观察；长期跟进由用户委托的 Task / Routine 承担。
向原群回复不是 Source 的行为，其他人的消息不自动成为用户的委托。

“所在群有新消息”沿用相同 Connector、消息结构、Input 和 Chief 路径。扩展时需在 Personal 明确群范围及触发策略，
增加独立水位；当前配置拒绝未实现的 `group` kind，避免误以为已开启完整群监听。

## 配置参数

以下字段属于 `plugins.personal.messages`：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `kinds` | `[direct, mention]` | 启用的输入场景；空数组关闭 |
| `intervalMs` | 60000 | 轮询间隔，最小 30000 |
| `overlapMs` | 300000 | 重叠扫描窗口，容纳索引延迟 |
| `initialLookbackMs` | 300000 | 首次观察回看时长，最大一天 |
| `contextWindowMs` | 900000 | 普通聊天上下文时间范围 |
| `beforeMessages` | 20 | 前文/话题起始页数量 |
| `afterMessages` | 10 | 后文/话题最近页数量 |
| `maxContextChars` | 16000 | 上下文正文总长度上限；原消息也受此长度上限约束 |
| `followupMs` | 300000 | 群内 @ 的短期跟进时长；0 关闭 |
| `contextAttempts` | 2 | 初始上下文失败尝试次数，达到后提交带缺口的原消息 |

每种场景每轮取一页搜索结果，每页最多十条，分页期间固定搜索窗口。
Connector 每次只取一页，不隐藏续页；每个 CLI 子进程默认超时二十秒、最大输出 4 MiB，同时最多两个消息读取请求。
重叠扫描不保证覆盖超过窗口的索引延迟；消息编辑和撤回不会自动生成修订 Input。

## 持久化与恢复

`MessageSource` status 保存分场景扫描窗口、水位、待处理消息、上下文重试和短期跟进进度。
发现页先持久化；该页匹配消息的 Input 均提交后才推进分页位置或水位。单聊查询失败不阻止已有群内观察继续处理。
每次投递先保存完整计划，再创建 Input，再保存消费位置。初始 Input 的身份由应用、用户、原消息 ID 确定；
讨论更新额外包含递增序号。进程在 Input 创建后中断时，恢复原计划，不重新采样并生成不同内容。
跟进读取失败会保留进度重试；到期仍失败时提交带失败信息的讨论更新，并结束短期观察。
配置变更生成新的 Source 配置实例，旧实例停止轮询；已提交 Input 保留。

## 验证

`tests/lark-messages.test.ts` 覆盖账号固定、CLI 映射、分页、错误脱敏、并发限制及 Connector/Chief 工具调用。
`tests/message-source.test.ts` 覆盖单聊与 @ 过滤、上下文缺口、分页水位、重启恢复、讨论跟进和真实 Runner 的 IPC 路径。
运行 `npm run check` 验证类型与全量测试。

上线前用服务账号验证单聊搜索、群内 @ 搜索、群历史和话题读取，特别检查机器人未入群的场景。
本地或其它租户中的成功不证明部署机器的登录态、权限及群覆盖范围。真实模型的路由和提醒效果需要另外验收。
