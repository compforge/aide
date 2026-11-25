# Channel

Channel 是 Aide 与用户沟通的入口和出口，负责接收消息、提供地址与话题线索、提交输入并投递回复。当前支持 Web 和 Lark 两种 Channel；Web 内置，Lark 可以配置多个命名实例。两者接入同一套 Personal 业务。

| Channel | 输入与会话划分 | 输出与交互 |
| --- | --- | --- |
| [Web](web.md) | URL 选择 topicId，左侧列表切换已有会话 | 消息、流式进展、历史执行、事项与安排；回答问题和原生 Harness 请求 |
| [Lark](lark.md) | 应用 ID + chat ID 确定会话；接收单聊与群内 @本机器人 | 流式卡片展示处理阶段与已投递回复；业务 Output 经披露检查后送到实际目标 |

## 默认通知地址

Default Topic 是系统维护的输入兜底处；defaultAddress 是 Aide 主动联系 Me 的具体私有场合，两者独立。缺省使用稳定的 Me Web 收件处，Web 仍按产出 Topic 展示消息记录。

Chief、Task、Routine 通过已知 AddressRef 选择目的地。明确答复保留 Input.source 和原消息坐标；没有唯一回复位置时联系 Me。默认选路在 say 接纳时固定到 Output，后续发送和重试不受默认配置切换影响。

Channel 只负责接收、平台位置标准化和实际发送；它消费应用注入的只读发言权限，不创建或更新 Address。连接凭证通过配置文件维护；Addresses 列表菜单负责禁言和默认通知地址，详情展示场合认识。凭证与 Person 身份的作用域独立，不能替换 appId 复用其他应用的 open_id。

## 输入、会话与回复

Channel 提交消息正文、原始地址、去重身份及可用的话题线索。Lark 按应用和聊天提供稳定 topicKey，群内 thread 可独立定位。Web 可显式选择已有 Topic。Source 也可以携带 topicKey 与来源地址。Route 决定 Input 归属，Web 的 Topic 视图可以查看来自不同渠道的材料。[Topic 定位](../personal/topic.md#topiclocator-能力) · [Input](../personal/input.md)

收到消息后，界面可立即展示已保存的 Input。答复与通知通过独立的 Output 发送。Lark 使用 Output 投递时确定的实际目标；回复地址与主动通知的选路见 [Output](../personal/output.md)。

## 投递与进度

正式回复与工作结果是持久 Output，Output Reconciler 按检查后 status.delivery 保存的实际 target/text 调用 Channel 发送并维护投递记录。失败重试不应重新执行已经完成的业务。客户端断开也不取消服务端 Task / Routine。

思考、工具调用和文字增量属于执行进展，来自 Harness 事件的有界实时投影。Me 的 Web 私有界面按需展示进展；Lark 卡片只消费通过披露检查的实际 Output Stream，私聊与群聊遵守各自的披露范围。进展不写成新的用户 Input，也不触发 Work。

Chief 的问答可通过两个 Channel 回答。当前原生 Harness 授权和 Hook 信任通过 Web 处理；网页按 Topic 筛选已关联的问题，未关联会话的宿主交互保留在本地收件区。

## 回复展示状态

主对话直接展示问题与回答，过程是独立的阅读入口。Web 的“查看过程”打开共用右侧面板，Gate 与 Topic 复用组件；飞书正文使用顶层 Markdown，“查看过程”是默认收起的同级面板。正文不嵌套在折叠容器中。

执行状态属于已有执行/Stream 投影，过程选择和展开状态属于读者；流式更新与完成不改变读者选择。错误、待回答问题和原生审批保持可见。正文只来自正式 Output，工具和阶段记录不新增业务消息。执行完成、Stream 结束与 Output 送达分别记录，不互相推断。

Web 私有过程按持久执行引用读取有界记录，历史详情不可用时明确提示；飞书只展示通过披露检查的实际 Stream。配置 Me 可达的 Web 地址后，私聊可附执行深链接；群聊不附私有 Web 过程链接。具体契约见 [Web](web.md#实时进展与历史) 与 [Lark](lark.md#过程反馈与最终答复)。

## 扩展边界

新的 Channel 需要解决平台消息接收、会话映射、去重与回复投递，并复用已有输入与交互入口。业务判断留在插件，Agent 执行留在 Harness。当前使用具体适配器，尚未抽取通用 Channel SDK。

资源对象与持久化见 [Resource](../plugin/resource.md)，Personal 判断流程见 [Personal](../personal/README.md)，部署见 [部署与诊断](../deployment.md)。

Channel 通过 `src/channel/service.ts` 的输入与投影接口接入应用，不依赖 Personal 或 Chief 的实现。Web 的 HTTP handler 位于 `src/api/`，通过扩展接口 `src/api/service.ts` 使用应用提供的 Work 侧栏、删除与事件能力；浏览器代码位于 `src/web/`。
