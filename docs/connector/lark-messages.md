# Lark 消息观察

用户收到的单聊、群内明确 @ 用户的消息，以及所在群的新消息，都是可以交给 Personal 判断的外部输入场景。
Source 保存观察事实，Chief 结合用户已有委托选择提醒、询问、关联工作或忽略。
Source 主动采集 `direct`（执行账号可读取的单聊收发）、`mention`（可访问群内明确 @ Me；未配置 Me 时观察执行账号的 @）和 `sent`（明确标记为 Me 的群内发言）。Me @别人或未 @任何人的群消息都能成为独立 Input，保留 `relation: sent`；这些外部交流仍是观察事实，是否提醒或推进由 Chief 结合已有委托判断。

## 接入与权限

Host 通过服务进程 PATH 中的 `lark-cli` 读取消息，使用服务用户 HOME 下已有的登录态。需要在运行 Aide 的机器上完成用户授权。
每次读取前核对 `appId` 和 `userId`，防止 CLI 切换账号后继续使用旧观察水位。用户 ID 是该应用下的 `open_id`。
配置不包含 token，Runner 不接收凭证，CLI 请求显式使用 `--as user`。

```yaml
connectors:
  lark:
    kind: messages
    version: v1
    config:
      appId: cli_example
      userId: ou_example
      timeoutMs: 20000
      me:
        - appId: cli_example
          openId: ou_human
plugins:
  personal:
    sources:
      lark: {}
```

省略 `plugins.personal.sources.lark` 不启动观察；声明 `lark: {}` 使用默认策略，不按消息类型限制输入。
执行账号与 Me 标记独立，登录态仅用于验证访问身份。两者不同时，不把执行账号的私信或 @ 当成本人收到；群内搜索在可访问结果中匹配 Me 的作用域 ID。仅当 Me 与执行用户唯一匹配时使用 CLI 的 is-at-me 过滤。
群内本人发言通过发送人过滤单独搜索，匹配当前应用作用域内 Me 的全部身份；未配置 Me 时不把登录账号当作 Me，也不启动本人发言扫描。三个场景分别推进水位，重复命中的消息复用同一个 Input。
只声明 Connector 时，Chief 仍可按需读取上下文。
已有 Lark Channel 的机器人交互不受此配置影响。初次启用默认观察最近五分钟，不导入全部历史。
观察资源按配置建立，不随 Topic 数量重复启动。Source 与机器人 Channel 使用下述同一套 Topic 归属规则。

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

## Topic 创建与归属

Lark 消息按应用、聊天及群话题确定 `Input.topicKey`；当前 key 映射到一个独立 ID / UID 的 Topic：

| 已接纳的消息 | Topic Key |
|---|---|
| 单聊，包括发给 Aide 机器人的单聊 | `lark:<appId>:<chatId>` |
| 群内 @ 或本人发言，消息没有 `threadId` | `lark:<appId>:<chatId>` |
| 群话题内 @ 或本人发言，消息有 `threadId` | `lark:<appId>:<chatId>:thread:<threadId>` |

普通群消息也有 chatId；是否属于独立话题由平台返回的 threadId 决定，不从正文、发送人、messageId 或 rootId 猜测。
同群不同话题分别建 Topic；同一话题不同成员的消息复用同一个 Topic。单聊始终按 chatId 归属。
用户身份 Source 与机器人 Channel 的 appId、chatId、threadId 相同时共用上下文；不同 appId 的来源 key 不同；之后仍可由 Weave 根据内容组织到共同根。userId 不参与 key。

首次接纳的消息建立 Topic，后续复用。[Route](../personal/route.md) 对 Lark Source 的明确话题直接创建并分派，
机器人 Channel 在接收入站时建立话题；两条路径均不让模型决定是否建会话。Source 的初始消息与短期 discussion 更新沿用同一规则，
不会因 originalInputId 曾被路由到 Default 而再次落入 Default。显示名称通过 TopicLocator 返回的 name 经 Input.topicName 传给 Route：普通群使用群名称；群话题使用“群名称 · 话题内容简述”，Source 优先使用已读到的根消息；私聊使用搜索结果提供的对方名称。无法取得名称时取首条输入预览。名称仅初始化新 Topic，后续消息不覆盖既有名称；改名不改变身份。
重复投递和重启复用现存对象；目标正在删除时拒绝向该对象分派。

会话创建与消息采集资格独立：Source 采集配置范围内的单聊、明确 @ 用户、群内本人发言和短期关联讨论；Channel 仍只接收单聊与精确 @ 机器人的群消息。
建立 Topic 不代表开始读取全群，也不延长默认五分钟的短期跟进。未被采集的消息不会因群或话题已经有 Topic 而自动进入。

Source 观察到的群地址不自动设置为 Topic 的默认回复地址。有 key 的来源主题随后收到机器人请求时，
Chief 可按该请求的 Input 地址回复；机器人与 Source 建立的来源 Topic 都不保存默认回复地址。共用上下文不额外授予发送权限，是否 say 仍由 Chief 根据委托判断。
发送地址仍是 appId 与 chatId，threadId 只划分内部上下文；当前回复与进展卡片发回原聊天，不新增平台话题内回复能力。
已完成 Input 不重分派。Weave 可以把相关 Topic 挂到新根下，key 仍指向原节点；节点回收后映射消失，新 Input 同 key 创建新实例。

## 消息与上下文

Connector 提供消息搜索、群历史和话题回复的分页读取，查询条件与 Personal 触发策略分离。
消息保留发送人、群、可用的 chatName、原消息 ID、时间、mentions、可用的回复与话题关联及原消息链接。
消息搜索原生返回 chat_name，Connector 直接映射为 chatName；不为每条 Source 消息额外查询群信息。群名随消息进入 observation 和精简模型预览，群名称缺失不构成消息读取失败。
`--is-at-me` 也可能命中 `@所有人`，Source 必须检查结构化 mentions 中的用户 ID。
三个场景均排除机器人发送的和已撤回的消息。本人发言保留为 `relation: sent`；
发给本人的消息为 `received`。上下文逐条保留 relation，普通讨论为 `observed`，可确认回复本人发言的消息为 `received`。
混合关系的讨论批次整体为 `observed`，Chief 必须依据各条消息的作者和 relation 积累认知，不能把整个讨论算成本人的观点。

收到原始单聊或 @ 消息即满足提交条件。初次观察尝试读取有限的前后文；话题优先取话题回复，并从附近群历史寻找根消息。
只有查到消息时才附带 `observation.context.messages`；没有结果、无权限或读取失败时省略 `observation.context`。
当轮仍提交原消息，不等待下一轮重试；读取失败原因记录在 Source 日志中，不写入 Input。
这不改变原消息的可见性：如果搜索未返回原消息，就没有可提交的 Input；搜索无结果与上下文失败分别记录。
有上下文时，`observedThrough` 表示查询截至时间，`truncated` 表示不完整，
`missingRoot` 标记话题根消息缺失。Chief 使用 `read_chat_messages` / `read_thread_messages` 按需继续读取。
CLI compact 时间可能只有分钟精度，Connector 固定进程时区为 UTC 后归一；上下文边界保留一分钟余量，
不能据此判断同一分钟内的精确先后顺序。

每条原消息生成一个稳定 Input，`observation.kind` 为 `direct`、`mention` 或 `sent`。
单聊的每条新消息各自触发发现。群内 @ 与本人发言在发现后继续观察短窗口，同话题或可识别的回复链出现新消息时，
追加 `discussion` Input，携带 `originalMessageId` 和 `originalInputId`。无关群消息不会仅因时间相近触发跟进。
再次明确 @ 用户或 Me 新发出的消息由其自己的发现 Input 承接，关联回复仍通过短期讨论补充。窗口结束后停止观察；长期跟进由用户委托的 Task / Routine 承担。
向原群回复不是 Source 的行为，其他人的消息不自动成为用户的委托。

“所在群有新消息”沿用相同 Connector、消息结构、Input 和 Chief 路径。扩展时需在 Personal 明确群范围及触发策略，
增加独立水位。配置不提供 `kinds` 白名单；单聊、群内 @ 与本人发言是当前 Source 的采集能力，
扩展 Source 后，新增类型的 Input 沿用下游处理流程，无需调整消息类型配置。

## 配置参数

以下字段属于 `plugins.personal.sources.lark`：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `intervalMs` | 60000 | 轮询间隔，最小 30000 |
| `overlapMs` | 300000 | 重叠扫描窗口，容纳索引延迟 |
| `initialLookbackMs` | 300000 | 首次观察回看时长，最大一天 |
| `contextWindowMs` | 900000 | 普通聊天上下文时间范围 |
| `beforeMessages` | 20 | 前文/话题起始页数量 |
| `afterMessages` | 10 | 后文/话题最近页数量 |
| `maxContextChars` | 16000 | 上下文正文总长度上限；原消息也受此长度上限约束 |
| `followupMs` | 300000 | 群内 @ 与本人发言的短期跟进时长；0 关闭 |

每种场景每轮取一页搜索结果，每页最多十条，分页期间固定搜索窗口。
Connector 每次只取一页，不隐藏续页；每个 CLI 子进程默认超时二十秒、最大输出 4 MiB，同时最多两个消息读取请求。
重叠扫描不保证覆盖超过窗口的索引延迟；消息编辑和撤回不会自动生成修订 Input。

## 持久化与恢复

`MessageSource` status 保存分场景扫描窗口、水位、待处理消息、投递计划和短期跟进进度。
发现页先持久化；该页匹配消息的 Input 均提交后才推进分页位置或水位。单聊查询失败不阻止已有群内观察继续处理。
Lark 搜索分页 token 被 API 1020 判为无效或过期时，只清除当前窗口的 token，记录恢复日志，下一轮从原窗口首页重扫；窗口边界、水位和待处理消息保持不变。已接收消息按原 Input 身份去重，整段分页完成后才推进水位。其它错误及没有 token 的首页失败不触发该恢复。
每次投递先保存完整计划，再创建 Input，再保存消费位置。初始 Input 的身份由应用、用户、原消息 ID 确定；
讨论更新额外包含递增序号。进程在 Input 创建后中断时，恢复原计划，不重新采样并生成不同内容。
跟进读取失败会保留进度重试；到期仍失败时记录日志并结束短期观察，不生成只有错误信息的讨论 Input。
配置变更生成新的 Source 配置实例，旧实例停止轮询；已提交 Input 保留。

## 验证

`tests/lark-messages.test.ts` 覆盖账号固定、CLI 映射、分页、错误脱敏、并发限制及 Connector/Chief 工具调用。
`tests/message-source.test.ts` 覆盖单聊、@ 与本人发言过滤、无上下文当轮提交、读取错误仅记日志、分页水位、重启恢复、讨论跟进、聊天话题归属和真实 Runner 的 IPC 路径。
运行 `npm run check` 验证类型与全量测试。

上线前用服务账号验证单聊搜索、群内 @ 与本人发言搜索、群历史和话题读取，特别检查机器人未入群的场景。
本地或其它租户中的成功不证明部署机器的登录态、权限及群覆盖范围。真实模型对输入的处理和提醒效果需要另外验收。
