# AGENTS.md

## 项目定位与边界

Aide 是小型、自托管的 personal agent，围绕用户交付的目标跨执行与等待持续跟进，减少用户催进度、重复背景与纠错的负担。Web / Lark Channel 与 Source 提交输入，Personal 插件的 Chief 负责判断，普通问题直接回复，需要跟进时操作 Task / Routine。Host / Runner 提供可供其它插件使用的运行机制。

按绿地视角开发，先走通个人助手场景，不建设账号权限中心、共享 SDK 或多实例平台。业务判断放在 Personal 与 Chief Agent；修改通用机制前先说明具体需求和现有能力缺口。

## 代码地图

```text
src/
  main.ts                  # 启动 Channel 与 Harness
  app.ts                   # 按入口 Session ID 装配 CoreSession / Personal，恢复与汇总各会话
  web/                     # 浏览器页面、脚本、样式与 Markdown 渲染
  api/                     # HTTP handler、静态资源与 SSE，调用 Core / Personal 能力
  address.ts               # Address 入站校验与比较
  channel/                 # Lark 适配、共享消息协议与执行投影
    address.ts             # ChannelAddress 编码与平台 endpoint 解析
  host/                    # 主进程：持久化、交互与执行事实
    resource/              # Host 持久资源数据库、容量、引用与释放策略
    input/                 # 独立 Input 事实、内置资源投影与文本 Printer
    output/                # 独立 Output、投递状态、容量策略与 Printer
    plugin/                # Resource / Printer / Controller / Source / Watch / verb
      resource/            # 资源存储、访问、类型注册与文本展示
        store.ts           # PluginResourceStore 与持久化校验
        type.ts            # 资源类型校验与身份键
        client.ts          # ResourceClient 与变更通知
        registry.ts        # 资源类型归属注册
        directory.ts       # 跨 Session 资源访问
        printer.ts         # describe / summarize 调用与默认展示
      runner/              # 宿主侧 Supervisor / IPC Client / 注册代理
    core/                  # CoreSession 执行组件装配
    controller/            # HarnessInput / Queue / Turn 执行协调
    harness/               # 模块配置契约与启动解析、Harness 注册、Adapter 与提供方协议
    store/                 # Session、Ledger 与执行投影
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
  aide.ts                  # Personal 服务：Chief 会话绑定、输入与恢复
  plugin.ts                # 插件入口：注册 Chief / Source / Task / Routine
  input.ts                 # Chief Input 路由与可恢复的多会话追加
  conversation/            # Conversation CRD 的模型、操作与 Reconcile
    model.ts               # 资源定义与会话类型
    input.ts               # 按 Input ID 幂等追加，保留消费状态与并发更新
    store.ts               # 宿主侧会话、Input 消费投影与消息流
    config.ts              # 组批、待处理上限和上下文预算
    trigger.ts             # 定时触发配置
    reconcile.ts           # Runner 调度 Batch、消费确认与定时回顾
    batch.ts               # Conversation 内部 Batch 模型
    reconcile-batch.ts     # 固定上下文执行与交接压缩
    state.ts               # Conversation / Batch 身份检查和 CAS 更新
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
  chief/                   # Personal 提示词、Person / Work / 问答 / Connector 工具
connectors/                # 全局环境目录、Meego / GitHub / GitLab 访问与数据映射
packages/plugin/           # @compforge/aide-plugin 公共契约
tests/                     # 内核、插件、Channel 与 Agent 验证
scripts/install-service.sh # Linux 用户级 systemd 服务
```

## 关键约定

- 根目录 `VERSION` 是产品版本。每次提交同步递增，默认 patch，同一提交只递增一次。
- 每种插件自定义资源（CRD）在所属 plugin package 下使用独立目录，按资源名命名；该资源的模型、Reconcile 和专属辅助代码归入目录。插件装配和跨资源协作留在插件层，共用机制不强行归入某一种 CRD。目录聚合不改变 Host / Runner 的依赖边界。
- Host / Runner 不相互导入实现。共享模块按职责放在 `src/`，不依赖两端实现。Runner 经 Resource API、Connector API 与 verb 请求宿主能力，不持有宿主 Store 或 Harness SDK。
- Connector 由 Host 从 `config.yaml` 装配，所有 Plugin 共用；环境声明直接位于 `connectors.environments.<name>`。Connector 声明访问能力，`plugins.<plugin>.sources` 声明观察策略；Personal 只启动显式配置的环境、Lark 与需求 Source。环境发现只读配置，不代表连通性、健康或操作授权。
- 各模块在自己的 config.ts 声明配置契约，启动装配解析一次，运行实例消费有效配置；进程期间不重读配置文件，修改后重启生效。配置遵循显式值大于默认值，空数组不回退；来源与字段归属见 `docs/configuration.md`。`harnesses.pi` 与 `harnesses.chief` 分别声明模型与能力包，包按 Harness 显式同步；内置装配只加载声明包中的 skills。
- Session 是持久执行作用域，保留 Ledger、Lane、Turn 与恢复绑定；CoreSession 负责进程期装配。Session 统一位于 `$AIDE_HOME/sessions/<id>/`，不按 project / cwd 分组。逻辑 ID 的目录编码由 SessionStore 负责。启动时恢复全部 Session 的工作和 Source；watch 仅装配到所属 Session。cwd 只是执行环境，改变时保留 Aide 历史并清空原生恢复绑定；插件私有数据仅有 global、session、instance 三个目录作用域。
- ChannelDefinition / SourceDefinition 声明来源身份；绑定的提交入口补齐来源，Source 同时记录资源实例引用。Input.text 保存收到的事实或请求，不保存 Chief 的处理指令。Channel / Source 输入统一从 Input 投影，Output 独立承载回复与通知；展示通过应用装配的定义目录读取名称和图标，不解释 Source 的业务数据。
- Input 是 Core 内置资源，可带上游话题线索 sessionId，稳定标识与粒度由 Channel / Source 决定；Conversation 是 Personal CRD，保存 Input 引用与各自消费状态。Channel / Source 不依赖 conversationId。Chief 先 Reconcile Input：无会话时创建并追加；已有会话时依次追加到默认会话、规则创建和规则关联的会话。确定归属即追加，不调用语义路由或汇总完整计划；创建使用稳定身份，追加按 Input ID 幂等，不新增路由 Verb。跨 Session 写入经过目标 ResourceClient 与 Watch，创建时按需装配目标 Session。
- Chief 对已有 Work 使用 append_input 投递事实或请求，输入队列与消费进度由 Work 持久保存；Task / Routine Reconcile 决定目标与执行状态，Chief 保留创建和删除资源的能力。
- Task / Routine 各有独立资源身份与 Reconcile；Work 是业务统称。Task 有完成条件，Routine 承担持续职责，执行时长和次数不决定类型。类型转换组合创建、暂停或删除，目标工作拥有新 id。
- Harness 原生 Session 由各 Harness 管理并使用其默认目录；Aide 按 Session × Lane × Target 保存原生身份和 Adapter 的 resumeState。
- Person 是 Personal 的人物 CRD，统一承载我与他人的身份和认知。PersonDefinition 声明 shared 作用域，资源和引用不带 sessionId，不启动执行会话；各 Conversation、Channel、Source 经 ResourceClient 访问同一目录。姓名不作身份键，provider / scope / id 唯一绑定人物。
- Me 是显式身份标记，connectors.lark.me 与 CLI 执行 appId/userId 独立。匹配 Person 的外部身份得到 Personal.me；本地单人 Web 有固定 Me 标记。Input.sender 可选，relation 为 sent / received / observed，缺省未知；机器人收发不自动代表本人，分类不构成执行授权。
- Chief 通过 profile_person 修订 Person.profile，每轮刷新 Me、按需读取他人。用户修正独立保存，Chief 不能覆盖；更新校验 uid/resourceVersion。Person 不持有 Input ID，不阻碍输入回收。Web Persons 与 Chief 共享资源更新路径；Hermes 提供其它通用记忆与检索，业务进展仍以 Task / Routine 为准。
- `pi` 提供通用 Agent，`chief` 加入 Personal 工具，两者复用 PiAdapter。通用 Pi 不依赖 Personal，Chief 的 WorkService 由宿主绑定范围；默认 Work 执行由根级 `defaultHarness` 选择，缺省为通用 Pi。
- Lark 用户消息 Source 按账号、用户和聊天生成独立观察话题，与机器人 Channel 会话分离，避免观察内容进入原群上下文和自动外发。
- Address 是通信位置父接口，ChannelAddress 是当前子接口；Input.source、Conversation.spec.address 与 Output.target 复用它。Conversation 只在由 Channel Input 创建时初始化默认地址，后续追加与 default 转发不能覆盖或补值。Immediate 直接回复指向 Input.source；其它沟通明确选 target 或使用 Conversation 默认地址，禁止从话题或 Conversation ID 推导投递地址。Input.sender / Output.receivers 引用 Person，Input.source / Output.target 使用 Address；人物、位置与来源分类独立，收件人不自动改变投递目标或产生额外发送。
- Source 先提交持久 Input 再推进观察水位。Input 与 Output 独立保存，业务状态、Output 创建与必要的去重记录原子提交，不能用投递失败重新触发业务执行。
- 持久 Resource 共用 Host 容量管理；资源所有者在 ResourceDefinition.retention 声明释放与引用规则，未知类型默认保护。按 kind 的 LRU 等排序只作用于可释放且无人引用的记录，不能淘汰正在承担的工作。详见 docs/plugin/README.md。
- Conversation.status.pendingInputIds 是唯一待消费队列，status.batch 固定一次处理材料。Conversation Reconcile 组批、确认消费和替换 Batch；具名 Batch Controller 执行 Harness，tool 直接调用 say / ask / confirm。完成批次保留有界上下文直到下一批继承；每批 freshContext 并持久化历史边界，失败不自动重放副作用。
- Harness 执行结束、业务目标完成和消息送达分别记录。业务 Controller 结合完成条件与外部证据解释结果，Core 保存执行事实。中断可能已经产生外部副作用，保留待核对状态，不自动重放。
- ResourceDefinition 统一声明类型、shared/session 作用域、Schema、Validator、Printer 与 retention。Host 在恢复和 Controller 启动前加载纯定义模块；所有写入（含 commit）在存储事务内校验。Controller 可独立注册零个或多个。Printer 在 Host 同步处理快照，describe / summarize 提供详情 / 概览，不执行 I/O、模型调用或修改资源；定义不随 Runner 关闭撤销。具体契约见 docs/plugin/README.md。
- 所有业务资源写入经过 Core ResourceClient，通知相关 Watch。主资源纯 status 更新不自动唤醒自身，需感知状态变化时声明 Watch。Verb 是 Controller 动作出口，其它组件可直接调用 Core 服务。
- 执行上下文显式携带主资源和可选 Conversation/Input 关联；Channel 不通过 Chief Target 推导问题和进度归属。
- Personal 将新发生的事归入能承接它的上下文：Conversation 承载话题，Task 承载有限目标，Routine 承载持续职责与当前轮次。Chief 优先关联已有 Work，再按需要创建；各 Reconcile 根据历史与新事实推进、更新、沟通、等待或忽略。详见 `docs/plugin/personal.md`。
- trigger 归属于 Conversation；新 Input 与定时回顾唤醒同一话题。Personal / Chief 决定回顾和主动沟通策略，Core 提供通用定时唤醒与恢复机制。say 保存独立 Output，不创建 Interaction；记忆中的偏好不自动成为执行委托。
- Chief 问答复用 Core Interaction；Task / Routine 的 waiting 是业务持久状态。两者的跨重启行为见 Personal 文档。
- Channel 进展消费既有执行投影与 Ledger，Web 使用 AgentUE。进度不写入业务 Output，不另建轨迹存储。
- `npm run check` 验证类型与测试。真实 Runner / SDK 加模拟外部服务不等于真实模型、CLI 或 Lark 已验证。

## References

- [Kernel](docs/kernel.md)：整体机制、输入对象、执行事实与恢复。
- [Plugin](docs/plugin/README.md)：插件运行、资源生命周期与调度；[公共契约](packages/plugin/README.md)。
- [Personal](docs/plugin/personal.md)：Chief、Task / Routine 和业务决策。
- [Harness](docs/harness/README.md)：通用执行契约；[Pi](docs/harness/pi.md)、[Chief](docs/harness/chief.md)。Chief 文档承载提示词、上下文与记忆优化方向。
- [Output](docs/output.md)：独立输出、原子提交、投递恢复与容量回收。
- [Channel](docs/channel/README.md)：Web 与 Lark；[Web](docs/channel/web.md)、[Lark](docs/channel/lark.md)。
- [Connector 与 Source](docs/connector/README.md)：关注范围、连接器配置和覆盖限制。
- [部署与诊断](docs/deployment.md)、[真实验收](docs/e2e.md)。
