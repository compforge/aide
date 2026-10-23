# AGENTS.md

## 项目定位与边界

Aide 是小型、自托管的 personal agent，围绕用户交付的目标跨执行与等待持续跟进，减少用户催进度、重复背景与纠错的负担。Web / Lark Channel 与 Source 提交输入，Personal 插件的 Chief 负责判断，普通问题直接回复，需要跟进时操作 Task / Routine。Host / Runner 提供可供其它插件使用的运行机制。

按绿地视角开发，先走通个人助手场景，不建设账号权限中心、共享 SDK 或多实例平台。业务判断放在 Personal 与 Chief Agent；修改通用机制前先说明具体需求和现有能力缺口。

## 代码地图

```text
src/
  main.ts                  # 启动 Channel 与 Harness
  app.ts                   # 装配全局 ApplicationRuntime、Personal 与通信入口
  web/                     # 浏览器页面；每页的 HTML、TS 入口、样式与交互模块放在一起
    conversations/         # 导航、时间线、输入、工作与审批；main 管理轮询和 SSE
    persons/               # 人物导航、资料和认识编辑
    shared/                # DOM、HTTP、剪贴板、Markdown 与公共样式
  api/                     # HTTP handler 与 SSE，调用 Core / Personal 能力
    assets.ts              # 固定页面路由、浏览器入口打包和静态资源缓存
    types.ts               # HTTP 展示投影的类型契约
  address.ts               # Address 入站校验与比较
  channel/                 # Lark 适配、共享消息协议与执行投影
    address.ts             # ChannelAddress 编码与平台 endpoint 解析
  host/                    # 主进程：持久化、交互与执行事实
    resource/              # Host 持久资源数据库、容量、引用与释放策略
    runtime/               # 应用级插件装配与资源执行上下文
      execution.ts         # Harness 执行服务、审批、生命周期与显式执行查询
    plugin/                # Resource / Printer / Controller / Source / Watch / verb
      resource/            # 资源存储、访问、类型注册与文本展示
        store.ts           # PluginResourceStore 与持久化校验
        type.ts            # 资源类型校验与身份键
        client.ts          # ResourceClient 与变更通知
        registry.ts        # 资源类型归属注册
        printer.ts         # describe / summarize 调用与默认展示
      runner/              # 宿主侧 Supervisor / IPC Client / 注册代理
    controller/            # HarnessInvocation 执行、上下文互斥与审批
    harness/               # Harness 注册、执行记录、Adapter 与提供方协议
      calls.ts             # 实时调用、等待与取消；Manager 只依赖能力接口
      activity.ts          # 有界实时执行投影，不持久化或回放
      configuration.ts     # Harness 配置选择与模型参数
      state.ts             # 执行事件的状态投影
    connector/             # Connector 调用事实、未知结果恢复与独立写入租约
    store/                 # 文件租约与消息投影辅助
  runner/                  # Plugin 注册、Watch、队列、重试、Source 与 Reconcile
  reconcile/               # 共用的去重队列、容量与定时机制
  protocol/                # Host / Runner 共用 IPC 与 verb 契约
  plugin-context.ts        # 共用上下文构造与 verb 参数校验
plugins/personal/
  person/                  # Person CRD 与跨会话人物目录
    model.ts               # 人物资料、外部身份、Me 标记和 profile
    catalog.ts             # Host 共享资源作用域与身份唯一性校验
    service.ts             # 人物解析、用户编辑和 Chief 认知更新
    relation.ts            # 输入与 Me 的关系
    messages.ts            # Connector 消息贡献人物事实
  input/                   # Input 定义、幂等接收、保留策略与 Printer
  output/                  # Output 定义、投递状态、action 与 Printer
  aide.ts                  # 全局 Personal 服务：Chief 上下文绑定、输入与恢复
  plugin.ts                # 插件入口：注册 Chief / Source / Task / Routine
  route/                   # 全局 Route CRD：规则分发、持续分类与原子分派
  conversation/            # Conversation CRD 的模型、操作与 Reconcile
    model.ts               # 资源定义与会话类型
    store.ts               # 宿主侧会话、Input 消费投影与消息流
    config.ts              # 输入预览与近期摘要预算
    trigger.ts             # 定时触发配置
    reconcile.ts           # 独立接收与 agent Controller、定时回顾
    assess.ts              # 原子研判完成与 Work 交接
    state.ts               # Conversation 身份检查和 CAS 更新
  source/                  # Source 分类定义与三类观察资源
    definition.ts          # 来源身份、名称与稳定图标
    environment/           # EnvironmentSource
      config.ts            # 环境观察目标与 namespace 策略
      observe.ts           # Workload 观察、基线和变化 Input
    message/               # MessageSource
      config.ts            # Lark 消息观察与跟进策略
      observe.ts           # 单聊、群内 @ 观察、水位和短期讨论跟进
      context.ts           # IM 有界上下文、话题根消息与缺口
    requirement/           # RequirementSource
      config.ts            # 需求观察范围与配置校验
      observe.ts           # 需求观察、水位和调度
  config.ts                # Conversation / Source 配置、严格校验与默认值
  task/                    # Task CRD
    model.ts               # 资源定义
    reconcile.ts           # 有限目标 Reconcile
  routine/                 # Routine CRD
    model.ts               # 资源定义
    reconcile.ts           # 持续职责 Reconcile
  model.ts                 # 共用 Work 字段、状态、消息与触发契约
  resources.ts             # Task / Routine 聚合与 Work 视图
  execution.ts             # Personal 共用执行、结果校验与记录
  work.ts                  # 会话范围内 Work 创建、追加输入与删除
  work-input.ts            # Work Reconcile 消费输入与应用请求
  store.ts                 # 宿主端工作存取、消息与去重投影
agents/
  pi/                      # 通用 Pi Agent：SDK、原生工具与会话
  route/                   # 专用路由 Agent，仅分类、目录和共享记忆检索
  chief/                   # Personal 提示词、Person / Work / 问答 / Connector 工具
connectors/                # 全局环境目录、需求平台 / GitHub / GitLab 访问与数据映射
packages/plugin/           # @compforge/aide-plugin 公共契约
tests/                     # 内核、插件、Channel 与 Agent 验证
scripts/install-service.sh # Linux 用户级 systemd 服务
```

## 关键约定

- 底座提供 TypeScript controller-runtime 机制，服务 Plugin Operator，Personal 是业务插件。单机是交付方式，未来服务端可使用真实 Kubernetes CRD；当前不预建 Kubernetes 后端。Plugin 契约不提供 Command、Mention、Board 或 Toast；展示与交互由应用和 Channel 负责。通用存储与调度不得导入 Personal Input / Output；应用装配负责安装定义、通信 action 和投递器。

- Web 按页面组织，页面入口负责组合模块与轮询、SSE 生命周期；交互状态由对应模块持有。公共浏览器能力放在 `web/shared`，HTTP 投影通过 type-only import 使用，跨 Channel 的展示投影仍归 `channel`。

- 根目录 `VERSION` 是产品版本。每次提交同步递增，默认 patch，同一提交只递增一次。
- 每种插件自定义资源（CRD）在所属 plugin package 下使用独立目录，按资源名命名；该资源的模型、Reconcile 和专属辅助代码归入目录。插件装配和跨资源协作留在插件层，共用机制不强行归入某一种 CRD。目录聚合不改变 Host / Runner 的依赖边界。
- Host / Runner 不相互导入实现。共享模块按职责放在 `src/`，不依赖两端实现。Runner 经 Resource API、Connector API 与 verb 请求宿主能力，不持有宿主 Store 或 Harness SDK。
- Connector 由 Host 从 `config.yaml` 装配，所有 Plugin 共用；环境声明直接位于 `connectors.environments.<name>`。Connector 声明访问能力，`plugins.<plugin>.sources` 声明观察策略；Personal 只启动显式配置的环境、Lark 与需求 Source。环境发现只读配置，不代表连通性、健康或操作授权。
- 各模块在自己的 config.ts 声明配置契约，启动装配解析一次，运行实例消费有效配置；进程期间不重读配置文件，修改后重启生效。配置遵循显式值大于默认值，空数组不回退；来源与字段归属见 `docs/configuration.md`。`harnesses.pi` 与 `harnesses.chief` 分别声明模型与能力包，包按 Harness 显式同步；内置装配只加载声明包中的 skills。
- ApplicationRuntime 服务 Plugin Operator；仅在配置 harness 时装配 ExecutionService。纯资源插件不要求 Harness，默认执行目标由应用配置提供。Manager 只接收 HarnessExecution 能力与独立 LogSink，不读取执行存储。Harness 自持原生会话和恢复，Aide 仅在资源 status.agent 保存必要引用；Connector 自持调用记录。资源、调度键和实例配置不依附 Session；CoreSession、SessionStore 和 SessionHandle 已移除。底座没有 Lane / Turn；一次执行统一使用 HarnessInvocation，Operator 按需保存恢复参数。不兼容旧 Session / Lane / Turn 存储，不增加迁移或双读；提供方原生标识留在 Adapter。插件私有目录只有 global 与 instance，详见 docs/kernel.md。
- ChannelDefinition / SourceDefinition 声明来源身份；绑定的提交入口补齐来源，Source 同时记录资源实例引用。Input.text 保存收到的事实或请求，不保存 Chief 的处理指令。Channel / Source 输入统一从 Input 投影，Output 独立承载回复与通知；展示通过应用装配的定义目录读取名称和图标，不解释 Source 的业务数据。
- Input / Output 由 Personal 定义；底座不预注册业务资源或 Session / Turn / Target 投影。Input.sessionId 仅是来源话题线索。Personal Route 监听 Input，规则命中立即追加，未命中由独立 Route agent Controller 调专用 Agent 分类；跨话题操作直接访问全局资源客户端。
- Conversation、Task、Routine、Person 用 status.summary 保存累计认识、recent 保存有界近期依据；所有写入通过共享 Schema 限制条数和总长度。Person 的长期 profile 不局限于这两个字段，用户修正直接写入同一个 summary，Chief 按最新版本继续维护；身份单独保存。Work 执行从目标、状态、summary/recent 和所选 Input 构造一次性 prompt；Input.handle 的请求应用与执行确认分开，执行结果和回执原子提交。Routine 事件经 Input 入站去重。
- Chief 用 assess_input 完成当前 Input 的研判并原子建立 Work 办理记录；独立新请求用 request_work 创建 origin=chief 的新 Input。Task / Routine Reconcile 按 handle 消费，不在 Work 保存输入副本或 consumedInputIds。
- Task / Routine 各有独立资源身份与 Reconcile；Work 是业务统称。Task 有完成条件，Routine 承担持续职责，执行时长和次数不决定类型。类型转换组合创建、暂停或删除，目标工作拥有新 id。
- Operator 按 Harness interface 经 verb 操作 agent loop；status.agent 只是 Personal 为服务重启保存调用参数的字段，不是底座契约。Harness verb 接收 harness / session 并返回已知恢复引用，不访问 ResourceClient。配置在启动时装配，Conversation 不注册专属 Target；没有独立 Context 会话目录。运行句柄与调用 ID 仅用于有界进程内协调。
- Plugin / Operator 的非 CRD 操作统一经过 Verb，CRD 使用 ResourceClient。harness verb 封装一个 Harness interface，提供 create/resume、prompt、followUp/steer、abort/close；不引入 Binding 或 Agent interface。运行中的追加交给原生 Harness 队列，回执不等于业务完成。Verb 记录调用关联、耗时和结果，不保存原生执行历史；恢复不自动重放输入。
- Person 是 Personal 的人物 CRD，统一承载我与他人的身份和认知。PersonDefinition 的资源属于 Personal 插件实例，资源和引用不带 sessionId，不启动执行会话；各 Conversation、Channel、Source 经 ResourceClient 访问同一目录。姓名不作身份键，provider / scope / id 唯一绑定人物。
- Me 是显式身份标记，connectors.lark.me 与 CLI 执行 appId/userId 独立；需求平台的 me.userKey 与 CLI profile、Source 负责人范围独立，规范项目 scope 由 Connector 解析。匹配 Person 的外部身份得到 Personal.me；本地单人 Web 有固定 Me 标记。Input.sender 可选，relation 为 sent / received / observed，缺省未知；机器人收发不自动代表本人，分类不构成执行授权。
- Chief 通过 profile_person 修订 Person.status.summary 并追加 recent，每轮刷新 Me、按需读取他人。用户直接修订同一个 summary，Chief 读取最新版本并尊重明确修正；更新校验 uid/resourceVersion。Person 不持有 Input ID，不阻碍输入回收。Web Persons 与 Chief 共享资源更新路径；Hermes 提供其它通用记忆与检索，业务进展仍以 Task / Routine 为准。
- `pi` 提供通用 Agent，`chief` 加入 Personal 工具，两者复用 PiAdapter。通用 Pi 不依赖 Personal，Chief 的 WorkService 由宿主绑定范围；默认 Work 执行由根级 `defaultHarness` 选择，缺省为通用 Pi。
- Lark 用户消息 Source 按账号、用户和聊天生成独立观察话题，与机器人 Channel 会话分离，避免观察内容进入原群上下文和自动外发。
- Address 是通信位置父接口，ChannelAddress 和 RequirementAddress 分别表达聊天位置与带规范项目 scope 的工作项位置；Input.source、Conversation.spec.address 与 Output.target 复用它。Conversation 只在由 Channel Input 创建时初始化默认地址，后续追加与 default 转发不能覆盖或补值。Immediate 直接回复指向 Input.source；其它沟通明确选 target 或使用 Conversation 默认地址，禁止从话题或 Conversation ID 推导投递地址。Input.sender / Output.receivers 引用 Person，Input.source / Output.target 使用 Address；人物、位置与来源分类独立，收件人不自动改变投递目标或产生额外发送。
- 需求平台评论经 Output 由 Host 投递；发送结果不确定时停止自动重试，仅由匹配目标、正文及投递记录的回读确认。自己的评论按回执识别，不按执行账号过滤。见 `docs/connector/requirements.md`。
- Source 先提交持久 Input 再推进观察水位。Input 与 Output 独立保存，业务状态、Output 创建与必要的去重记录原子提交，不能用投递失败重新触发业务执行。
- 持久 Resource 共用 Host 容量管理；资源所有者在 ResourceDefinition.retention 声明释放与引用规则，未知类型默认保护。按 kind 的 LRU 等排序只作用于可释放且无人引用的记录，不能淘汰正在承担的工作。详见 docs/plugin/README.md。
- Input.status.route / assess / handle 分别保存路由、各 Conversation 研判、各 Work 办理痕迹。Route / Conversation 不存待办 ID 队列。Reconcile 负责确定性规则与协调，持续 Route / Chief Agent 接收 followup，immediate 可 steer；工具回执才确认完成。Route 按 Input 退避重试，Chief 未确认的副作用保持待核对。
- Harness 执行结束、业务目标完成和消息送达分别记录。业务 Controller 结合完成条件与外部证据解释结果，Core 发布实时执行进度。中断可能已经产生外部副作用，保留待核对状态，不自动重放。
- ResourceDefinition 统一声明类型、Schema、Validator、Printer 与 retention；资源统一按插件实例与 namespace 组织。Host 在恢复和 Controller 启动前加载纯定义模块；所有写入（含 commit）在存储事务内校验。Controller 可独立注册零个或多个。Printer 在 Host 同步处理快照，describe / summarize 提供详情 / 概览，不执行 I/O、模型调用或修改资源；定义不随 Runner 关闭撤销。具体契约见 docs/plugin/README.md。
- 所有业务资源写入经过 Core ResourceClient，通知相关 Watch。主资源纯 status 更新不自动唤醒自身，需感知状态变化时声明 Watch。Verb 是 Controller 动作出口，其它组件可直接调用 Core 服务。
- 执行上下文携带主资源与不透明 attributes；只有 Personal 解释其中的 Conversation/Input 关联。Reconcile 快照不含全局历史；Channel 根据 Personal 的关联显式查询执行记录，不通过 Chief Target 推导进度归属。
- Personal 将新发生的事归入能承接它的上下文：Conversation 承载话题，Task 承载有限目标，Routine 承载持续职责与当前轮次。Chief 优先关联已有 Work，再按需要创建；各 Reconcile 根据历史与新事实推进、更新、沟通、等待或忽略。详见 `docs/plugin/personal.md`。
- trigger 归属于 Conversation；新 Input 与定时回顾唤醒同一话题。Personal / Chief 决定回顾和主动沟通策略，Core 提供通用定时唤醒与恢复机制。say 保存独立 Output；记忆中的偏好不自动成为执行委托。
- Chief 用 say 提出问题并结束当前调用；用户后续消息作为普通 Input。业务 ask / confirm / draft 与 Interaction 已移除；Harness 原生工具权限与 Hook 信任使用独立的 Approval，仍需明确决定；拒绝权限只拒绝本次请求，取消执行会中断该审批关联的运行。Task / Routine 的 waiting 是业务持久状态。
- Channel / Source 提交 Input 后由 Route 分派，route_input 原子写入路由结果和全部 assess。assess_input 原子完成研判、建立 handle。完成记录不重置，say 独立产生 Output；全部阶段完成后 Input 才能按 Host 容量策略回收，删除目标明确取消未完成阶段。
- Channel 进展消费有界实时执行投影，Web 使用 AgentUE。进度不写入业务 Output，不另建轨迹存储。
- `make lint` 执行 TypeScript 类型检查，`make test` 执行完整测试；`npm run check` 仍组合两项校验。`packages/plugin` 的 `make lint` 检查其公开契约，`make test` 委托根目录集成测试。真实 Runner / SDK 加模拟外部服务不等于真实模型、CLI 或 Lark 已验证。

- Route/global 属于 Personal，保存当前 execution 与原生 agent 会话引用。默认 Controller 处理规则，具名 agent Controller 驱动持续 Route；route_input 只向 Route 暴露，无合适目标才用 Default。Route 与 Chief 共用 Hermes 记忆但隔离原生上下文，Route 仅检索、不执行业务动作。

## References

- [Kernel](docs/kernel.md)：整体机制、输入对象、执行事实与恢复。
- [Plugin](docs/plugin/README.md)：插件运行、资源生命周期与调度；[公共契约](packages/plugin/README.md)。
- [Personal](docs/plugin/personal.md)：Chief、Task / Routine 和业务决策。
- [Harness](docs/harness/README.md)：通用执行契约；[Pi](docs/harness/pi.md)、[Chief](docs/harness/chief.md)、[Route](docs/harness/route.md)。Chief 文档承载提示词、上下文与记忆优化方向。
- [Output](docs/output.md)：独立输出、原子提交、投递恢复与容量回收。
- [Channel](docs/channel/README.md)：Web 与 Lark；[Web](docs/channel/web.md)、[Lark](docs/channel/lark.md)。
- [Connector 与 Source](docs/connector/README.md)：关注范围、连接器配置和覆盖限制。
- [部署与诊断](docs/deployment.md)、[真实验收](docs/e2e.md)。

## 定向验证

根目录 `make test` 接收空格分隔的 `TEST_FILES`，路径相对于仓库根目录；未传或空值执行全套测试。devloop 先选择受影响的 Component，再自动传入文件列表，通常不手动指定。Bun 接收明确文件路径，避免 `npm test -- ...` 在原有 `tests` 参数之外追加筛选条件导致仍执行全量。

`make lint` 接收 `LINT_FILES`，但当前静态检查只有 TypeScript typecheck，会保留 tsconfig 并扩展到整个 Component 的类型依赖图。`packages/plugin` 使用自己的 tsconfig；没有包内测试，`make test` 清空文件选择后委托根目录的集成测试。未配置 formatter，因此不添加空操作的 `make fix`。
