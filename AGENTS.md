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
    topics/                # 导航、时间线、输入、工作与审批；main 管理轮询和 SSE
    persons/               # 人物导航、资料和认识编辑
    inputs/                # 跨会话输入筛选、分页与处理 Timeline
    connections/           # 沟通渠道配置与默认沟通渠道
    shared/                # DOM、HTTP、剪贴板、Markdown 与公共样式
  api/                     # HTTP handler 与 SSE，调用 Core / Personal 能力
    assets.ts              # 固定页面路由、浏览器入口打包和静态资源缓存
    types.ts               # HTTP 展示投影的类型契约
  address.ts               # Address 入站校验与比较
  channel/                 # Lark 适配、共享消息协议与执行投影
    address.ts             # ChannelAddress 编码与平台 endpoint 解析
    lark/                  # Lark 机器人 Channel
      index.ts             # 入站接纳、出站投递与持久回执
      client.ts            # SDK、凭证配置与安全错误诊断
      card.ts              # 执行进展投影与卡片内容
  host/                    # 主进程：资源持久化、外部能力与实时执行
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
    harness/               # Harness 注册、实时执行投影、Adapter 与提供方协议
      calls.ts             # 实时调用、等待与取消；Manager 只依赖能力接口
      activity.ts          # 有界实时执行投影，不持久化或回放
      configuration.ts     # Harness 配置选择与模型参数
      state.ts             # 执行事件的状态投影
    connector/             # 外部包加载、Kind 注册与调用、连接生命周期、调用事实及未知结果恢复
    store/                 # 文件租约与消息投影辅助
  runner/                  # Plugin 注册、Watch、队列、重试、Source 与 Reconcile
  reconcile/               # 共用的去重队列、容量与定时机制
  protocol/                # Host / Runner 共用 IPC 与 verb 契约
  plugin-context.ts        # 共用上下文构造与 verb 参数校验
plugins/personal/
  person/                  # Person CRD 与跨会话人物目录
    model.ts               # 人物资料、外部身份、Me 标记与认识
    catalog.ts             # Host 共享资源作用域与身份唯一性校验
    service.ts             # 人物解析、用户编辑、显式合并和 Chief 认知更新
    reconcile.ts           # 无外部清理动作的标准删除生命周期
    relation.ts            # 输入与 Me 的关系
    messages.ts            # Connector 消息贡献人物事实
  input/                   # Input 定义、幂等接收、分页检索、保留策略与 Printer
  output/                  # Output 定义、投递状态、action 与 Printer
  observation/             # Input JobView、原生调用引用与业务证据关联
  aide.ts                  # 全局 Personal 服务：领域工具装配、输入与恢复
  plugin.ts                # 插件入口：注册 Chief / Source / Task / Routine
  weave/                   # 全局 Weave CRD、有界扫描与 Topic 关系整理
  route/                   # 全局 Route CRD：规则分发、持续分类与原子分派
  topic/                   # Topic CRD 的模型、操作与 Reconcile
    locator.ts             # Channel / Source 提供 Topic 定位信息的领域契约
    model.ts               # 资源定义与会话类型
    store.ts               # 宿主侧会话、Input 消费投影与消息流
    config.ts              # 输入预览与近期摘要预算
    trigger.ts             # 定时触发配置
    reconcile.ts           # 独立接收与 agent Controller、定时回顾
    assess.ts              # 原子研判完成与 Work 交接
    state.ts               # Topic 身份检查和 CAS 更新
  source/                  # Source 分类定义与业务观察资源
    definition.ts          # 来源身份、名称与稳定图标
    environment/           # EnvironmentSource
      config.ts            # 环境观察目标与 namespace 策略
      observe.ts           # Workload 观察、基线和变化 Input
    message/               # MessageSource
      config.ts            # Lark 消息观察与跟进策略
      observe.ts           # 单聊、群内 @ 与本人发言观察、水位和短期讨论跟进
      context.ts           # IM 有界上下文、话题根消息与缺口
    repository/            # RepositorySource：仓库清单缓存、分页刷新与 PR 观察任务交接
    pull-request/          # PullRequestSource：按仓库或账号扫描、合并 Input 与恢复进度
    snapshot.ts            # Source 已提交事实与观察时间；刷新和交接进度由各 Source 持有
    configure.ts           # 观察策略更新保留同一观察范围的 UID 与检查点
    requirement/           # RequirementSource
      config.ts            # 需求观察范围与配置校验
      observe.ts           # 需求观察、水位和调度
  config.ts                # Topic / Task / Routine / Source 配置、严格校验与默认值
  task/                    # Task CRD
    model.ts               # 资源定义
    reconcile.ts           # 输入接收、持续执行与两阶段静默回收
    agent.ts               # Host 绑定 Task / Topic 工具范围
    config.ts              # agent 静默与 Task 保留时长
  routine/                 # Routine CRD
    model.ts               # 资源定义
    reconcile.ts           # 持续职责执行与静默释放 agent
    agent.ts               # Host 绑定 Routine / Topic 工具范围
    config.ts              # agent 静默时长
  model.ts                 # 共用 Work 字段、状态、消息与触发契约
  resources.ts             # Task / Routine 聚合与 Work 视图
  work-report.ts           # Task / Routine 原子进展与 Input 回执
  work-status.ts           # Work Agent 状态契约
  work.ts                  # 会话范围内 Work 创建、追加输入与删除
  work-input.ts            # Work Reconcile 查询 Input 办理记录与应用请求
  store.ts                 # 宿主端工作存取、消息与去重投影
agents/
  pi/                      # 通用 Pi Agent：SDK、原生工具、会话与有界 Observation 补录
  route/                   # 专用路由 Agent，仅分类、目录和共享记忆检索
  weave/                   # 专用主题整理 Agent，识别 root 关联并提议归组
  task/                    # 稳定目标的持续办理 Agent，复用 Pi
  routine/                 # 持续职责 Agent，复用 Pi
  chief/                   # Personal 提示词、Person / Work / 问答 / Connector 工具
connectors/                # 全局环境目录、需求平台访问；Forge 配置装配与 repocli 只读能力
packages/connector/        # @compforge/aide-connector：通用 Kind、连接描述、外部实现与调用契约
packages/plugin/           # @compforge/aide-plugin：Resource、Controller、Source、Watch 与 Hook 公共契约
tests/                     # 内核、插件、Channel 与 Agent 验证
scripts/install-service.sh # Linux 用户级 systemd 服务
```

## 关键约定

- Aide 是 Me 的独立助理；Chief / Route / Weave / Task / Routine 是助理内部角色。外部交流不是自动委托，凭证不决定身份；摘要、归并和工作交接保留作者、确认状态与授权范围。身份契约见 [Kernel](docs/kernel.md#助理定位与身份边界)。
- 底座提供 TypeScript controller-runtime，服务 Plugin Operator；Personal 拥有 Input、Output、Person、Topic、Task、Routine 与业务判断。通用资源和调度不能导入 Personal，应用装配负责安装定义、通信 action 和投递器。
- Host / Runner 不互相导入实现。Runner 经 ResourceClient、Connector API 与 Verb 请求宿主能力，不持有 Store、凭证客户端或 Harness SDK。共享协议放在 src/protocol，公共插件契约放在 packages/plugin。
- 每种 CRD 在所属 plugin package 下有独立目录，模型、Reconcile 和专属辅助代码就近组织；跨资源协作留在插件层。ResourceDefinition 集中声明 Schema、校验、Printer、索引与保留策略；所有写入在存储事务内校验，提交后通知 Watch。
- 资源身份按插件实例与 namespace 组织，引用固定 UID。同一 Controller 对同一资源串行；主资源纯 status 更新不自动唤醒自身，协作方显式声明 Watch。资源所有者决定能否释放，Host 执行容量限制与合格对象的淘汰排序。
- Operator 通过 Harness interface / verb 操作原生 agent loop，恢复参数由 Operator 自己保存。Personal 的 status.agent 只是调用参数；Harness verb 不读写 CRD。原生持久化、历史与恢复属于 Harness，实时投影和诊断日志不承担恢复。
- Route、Chief、Task、Routine、Weave Agent 只由各自对应的 Reconcile 触发，包括 prompt、steer 与 followUp；协作组件和 Agent 工具通过资源变化协作，不直接触发其它角色。
- Input、Task、Routine 通过 status.topic 保存唯一且可调整的 Topic UID 引用；Input.assess 保存全局唯一研判及 Chief 接纳 executionId，自动 prompt / steer / followUp 在提交前通过资源事务竞争接纳；Topic 保存 Chief 执行与原生会话。Route 保存首次路由回执，Chief 在树内整理归属，Weave 只改变父子关系。
- 接纳回执、Input 处理完成、工作目标达成与 Output 送达是独立事实。持续 Agent 使用原生 followUp / steer；工具回执确认业务完成。可能已有外部副作用的中断先核对，不自动重放。
- Channel / Source 通过绑定 Definition 的入口形成 Input，正文保存事实，证据留在 observation。路由统一归 Route，Default Topic 由系统按需创建并维护，只兜底，不提供手动切换；Input.status 的 route / assess / handle 是处理事实，消费者按索引查询。
- Person 保存人物身份与认识，Me 是可选标记，与访问凭证独立。Input.sender / Output.receivers 引用 Person，Input.source / Output.target 使用 Address；来源 topicKey、通信地址和授权分别判断。
- Topic、Task、Routine、Person 用 summary 保存长期有效、低频变化的认识，recent 保存按稳定 Note ID 持续更新的近期事项；两者独立写入，办理报告只确认业务状态与 Input 回执。结构化目标与身份各自保留。用户修订直接进入 Person 的同一个 summary，Agent 按最新版本继续维护。
- Task 承担有限目标，Routine 承担持续职责。领域 Agent 与通用 Pi 共用适配，工具按资源 UID 和当前 execution 绑定；业务请求与消费凭据落在 Input。Chief / Work 通过 say 产生独立 Output，report 与 say 分别提交；普通回答是新 Input，原生权限由独立 Approval 处理。
- Forge 的 Repository / PullRequest 模型复用 harness-common，平台读取、增量发现完整性、不透明游标与 HTTP 约束由 repocli lib 承担；Aide Connector 负责配置与调用路由，Personal RepositorySource 负责清单缓存与观察任务交接，PullRequestSource 负责 PR 基线、检查点与 Input。契约见 [Forge](docs/connector/forge.md)。
- Connector kind 与 version 是独立字符串，connectors 直接按 name 声明；领域 interface 定义操作契约，安装入口按 name 注册实现，配置不使用 type 或 packages/instances 包装；Plugin 与 verb 按 kind 发现 Connector 并通过同一客户端调用，私有配置和凭证不进入 Runner。Source 继续复用 Plugin 机制，Connector 是否作为 Resource 独立演进。契约见 [Connector 扩展](docs/connector/extensions.md)。
- Connector 按外部系统或服务组织操作与适配；一个 Connector 可支持多个业务 Source，Source 可细到单个业务 Resource，按观察生命周期独立保存状态与调度。长期访问约束包括可配置限速与并发预算，由共享该外部配额的调用统一遵守。边界与建设状态见 [Connector 与 Source](docs/connector/README.md)。
- plugins.<plugin>.sources 声明观察策略，形成 Input 的 Source 先保存 Input 再推进水位。所有模块在自己的 config.ts 声明契约，启动时解析一次；显式值优先于默认值，空数组不回退，运行中不重读配置。Web 可保存命名 Channel 与 defaultChannel 到同一份配置，重启生效；默认 say 联系 Me，不依赖 Topic 的来源地址或私聊历史。
- Web 按页面组织，入口管理轮询与 SSE 生命周期，交互模块持有自身状态；共用浏览器能力放在 web/shared，展示类型经 type-only import 使用。Channel 展示进展不产生业务 Output。
- 根目录 VERSION 是产品版本，每次提交递增一次，默认 patch。设计文档描述当前模型与 why，详细契约各有主说明位置，其它文档用链接引用；代码意图标记链接到对应主题。

## References

- [文档导航](docs/README.md)：使用、开发与验收的阅读入口。
- [Kernel](docs/kernel.md)、[Plugin](docs/plugin/README.md)、[Resource](docs/plugin/resource.md)：底座边界、协调、定义、事务与容量；[公共契约](packages/plugin/README.md)。
- [Personal](docs/personal/README.md)：对象与完整流程；[Input](docs/personal/input.md)、[Route](docs/personal/route.md)、[Topic](docs/personal/topic.md)、[Output](docs/personal/output.md)。
- [Topic](docs/personal/topic.md)、[Weave](docs/personal/weave.md)：来源归属、知识融合、root 处理与静默回收契约。
- [Chief](docs/personal/chief.md)：判断、提示词、上下文与记忆优化；[Person](docs/personal/person.md)、[Task](docs/personal/task.md)、[Routine](docs/personal/routine.md)。
- [Harness](docs/harness/README.md)、[Pi](docs/harness/pi.md)：通用执行契约与原生适配。
- [Channel](docs/channel/README.md)：[Web](docs/channel/web.md)、[Lark](docs/channel/lark.md)。
- [Connector 与 Source](docs/connector/README.md)：[Forge](docs/connector/forge.md)、[环境](docs/connector/environments.md)、[Lark 消息](docs/connector/lark-messages.md)、[需求平台](docs/connector/requirements.md)。
- [Observation](docs/observation.md)：Input JobView、原生 SessionView、请求补录与证据缺口。
- [配置](docs/configuration.md)、[部署与诊断](docs/deployment.md)、[真实验收](docs/e2e.md)。

## 定向验证

根目录 `make test` 接收空格分隔的 `TEST_FILES`，路径相对于仓库根目录；未传或空值执行全套测试。devloop 先选择受影响的 Component，再自动传入文件列表，通常不手动指定。Bun 接收明确文件路径，避免 `npm test -- ...` 在原有 `tests` 参数之外追加筛选条件导致仍执行全量。

`make lint` 接收 `LINT_FILES`，但当前静态检查只有 TypeScript typecheck，会保留 tsconfig 并扩展到整个 Component 的类型依赖图。`packages/plugin` 使用自己的 tsconfig；没有包内测试，`make test` 清空文件选择后委托根目录的集成测试。未配置 formatter，因此不添加空操作的 `make fix`。
