# Channel

Channel 是 Aide 与用户沟通的入口和出口，负责接收消息、提供地址与话题线索、提交输入并投递回复。当前支持 Web 和 Lark 两种 Channel；Web 内置，Lark 可以配置多个命名实例。它们接入同一套 Personal 业务，Chief 负责理解与判断，Task / Routine 负责持续工作。

| Channel | 输入与会话划分 | 输出与交互 |
| --- | --- | --- |
| [Web](web.md) | URL 选择 topicId，左侧列表切换已有会话 | 消息、流式进展、历史执行、事项与安排；回答问题和原生 Harness 请求 |
| [Lark](lark.md) | 应用 ID + chat ID 确定会话；接收单聊与群内 @本机器人 | 流式卡片展示处理阶段与已投递回复；业务 Output 经披露检查后送到实际目标 |

## 默认通知地址

Default Topic 是系统维护的输入兜底处；defaultAddress 是 Aide 主动联系 Me 的具体私有场合，两者独立。缺省使用稳定的 Me Web 收件处，Web 仍按产出 Topic 展示消息记录。

Chief、Task、Routine 通过已知 AddressRef 选择目的地。明确答复保留 Input.source 和原消息坐标；没有唯一回复位置时联系 Me。默认选路在 say 接纳时固定到 Output，后续发送和重试不受默认配置切换影响。

Channel 只负责接收、平台位置标准化和实际发送；它消费应用注入的只读发言权限，不创建或更新 Address。连接凭证通过配置文件维护；Addresses 列表菜单负责禁言和默认通知地址，详情展示场合认识。凭证与 Person 身份的作用域独立，不能替换 appId 复用其他应用的 open_id。

## 输入、会话与回复

Channel 提交用户消息时提供 source 地址、稳定 sessionId 与消息去重身份，不需要理解 Personal 的 Topic。Lark 使用应用与聊天身份，Web 使用所选 Topic 的话题标识。Channel 通过绑定 Definition 的入口提交消息，Core 保存 Input 并返回持久化回执；Personal 经 Route 决定归属。输入直接投影为输入卡片，Output 独立承载回复与通知；接收成功不代表模型已经回答或目标已经完成。

Personal 决定输入进入哪个 Topic、是否创建 Work。普通回答直接进入消息流，需要持续跟进时才操作 Task / Routine。同一话题的后续消息可以回答问题或补充已有工作。Web 的 Topic 列表是 Personal 的业务视图，可以查看 Lark 或 Source 会话。

Source 是外部观察入口，可以提交带话题 sessionId 或没有话题线索的 Input，也可以携带观察所在的 source 地址。Route 分派后，Chief决定是否及向哪里沟通；Lark transport 使用 Reconciler 传入的实际目标，不从话题身份推导聊天目标。地址与收件处选择见 [Output](../personal/output.md)。

## 投递与进度

正式回复与工作结果是持久 Output，Output Reconciler 按检查后 status.delivery 保存的实际 target/text 调用 Channel 发送并维护投递记录。失败重试不应重新执行已经完成的业务。客户端断开也不取消服务端 Task / Routine。

思考、工具调用和文字增量属于执行进展，来自 Harness 事件的有界实时投影。Me 的 Web 私有界面使用 Markdown 展示完整进展；Lark 卡片只展示通用处理阶段和通过披露检查、已经投递的正文，不展示私有思考或工具内容。进展不写成新的用户 Input，也不触发 Work。

Chief 的问答可通过两个 Channel 回答。当前原生 Harness 授权和 Hook 信任通过 Web 处理；网页按 Topic 筛选已关联的问题，未关联会话的宿主交互保留在本地收件区。

## 回复展示状态

以下完整过程展示适用于 Me 的 Web 私有界面。Lark 使用独立的两个同级面板：回答默认展开、过程默认收缩，正文直接展示且无重复预览；具体见 [Lark 展示](lark.md#过程反馈与最终答复)。一次执行的回复展示包含「过程」和「回答」两个区域。「过程」容纳思考、工具调用、阶段性说明等中间内容；「回答」呈现交付给用户的正文。执行状态来自已有投影，展开状态属于用户的阅读选择；两个区域独立控制，外层默认展开，也可手动整体收起。

| 展示态 | 过程 | 回答 |
| --- | --- | --- |
| 进行态 | 最新思考一行、当前工具及状态一行；优先显示仍在执行的工具 | 三行以内的最新正文节选；尚未输出时显示等待生成 |
| 缩略态 | 执行结果与工具调用数量的简短概况 | 正文开头最多三行，超出省略 |
| 完整态 | 展开已有思考和工具记录 | 展开完整 Markdown 正文 |

Web 默认在执行中显示进行态，结束后显示缩略态。用户可随时展开详情；增量更新、结束及问答续轮不覆盖手动展开选择。收起详情后，依据当前执行状态恢复进行态或缩略态。等待用户回答、失败和中断使用明确状态，需处理的问题及提示默认可见。

预览只节选已有内容，不另调模型生成摘要；工具状态保留执行中、完成、失败等原始含义，模型未输出思考时显示实际处理阶段。进展与正式 Output 通过执行关联分组展示，进展本身不重复投递为业务回复。平台文本预算之外的完整内容沿用各 Channel 的历史查看或长文投递方式。

## 扩展边界

新的 Channel 需要解决平台消息接收、会话映射、去重与回复投递，并复用已有输入与交互入口。业务判断留在插件，Agent 执行留在 Harness。当前使用具体适配器，尚未抽取通用 Channel SDK。

内核对象与持久化见 [Kernel](../kernel.md)，Personal 判断流程见 [Personal](../personal/README.md)，部署见 [部署与诊断](../deployment.md)。

Channel 通过 `src/channel/service.ts` 的输入与投影接口接入应用，不依赖 Personal 或 Chief 的实现。Web 的 HTTP handler 位于 `src/api/`，通过扩展接口 `src/api/service.ts` 使用应用提供的 Work 侧栏、删除与事件能力；浏览器代码位于 `src/web/`。
