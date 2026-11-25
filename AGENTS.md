# AGENTS.md

## 项目定位与边界

Aide 是小型、自托管的 personal agent，将持续到来的信息转化为认识、行动与有价值的沟通，围绕用户目标跨执行与等待持续跟进。Personal 结合已有 Note 与最新 Input 作判断，按需更新事实与方法以及对象摘要、调整 Topic tree，并产生必要的 Output。近期与长期认识统一保存为 Note；认知更新可以静默发生，私下答复 Me 不必先写 Note；对外正文须引用可分类的 Note。Web / Lark Channel 与 Source 提交输入，Chief 直接处理简单事情。需要后续承接时，统一通过 upsert_work 声明 Work：一次性目标或循环职责交给 Task / Routine Agent，Ongoing 记录仍会演进、需要持续跟进的同一事项。Host / Runner 提供通用运行机制。

项目有两个目标：做好 personal agent，并积累可复用的 TypeScript controller-runtime 底座。Personal 是底座的首个应用与验证场景，领域模型留在插件，通用资源、查询和调度能力沉淀到底座。按绿地视角开发，不建设账号权限中心或多实例平台。业务判断放在 Personal 与 Chief Agent；修改通用机制前先说明具体需求和现有能力缺口。

Aide 是多角色并行系统：Input 经多个角色转换、加工和处理，贡献到 Output 或 Note 中。角色的本质是 Reconciler；Agent 为角色提供智能化执行能力，对外属于 Reconciler 的内部细节。角色通过资源事实协作，完成以持久化结果为准。

典型流转是：Channel／Source 形成 Input → Route 确定 Topic 归属 → Chief 接纳并处理。Deferred 分支先由 [Secretary](docs/personal/secretary.md) 整理成 Batch，再交给 Chief；Secretary 生成的内部维护 Input 直接绑定目标 Topic。aide:curate 按批梳理新增或改动的普通 Note，归类、去重；aide:organize 整理 Topic 树及材料归属，可拆分或移动普通 Note；aide:summary 在 Chief 空闲时复核一个 Topic、Person 或 Address 的默认认识；aide:followup 跟进需要回应的事项，按独立 Ongoing 的预约核实事项进展，仍无法判断时私下询问 Me。Chief 可以直接更新 Note、产生 Output，也可以通过 Input 的 Work 请求交给 Task／Routine 持续办理；这些角色产生的 Output 再进入披露与投递流程。一条 Input 可以贡献到多个产物，多条 Input 也可以共同形成一个 Note 或 Output。

Gate 承接 Me 的全局输入并按需交办领域 Chief；Weave 调整 Topic 之间的组织关系，影响后续处理归属。各角色并行协调自身资源，按分支参与处理；Input 的 route／assess／handle 分别保留路由、投递和办理事实，处理完成、工作目标达成与 Output 送达各有自己的回执。

## 代码地图

```text
src/
  main.ts                  # 启动 Channel 与 Harness
  app.ts                   # 装配全局 ApplicationRuntime、Personal 与通信入口
  web/                     # 浏览器页面；每页的 HTML、TS 入口、样式与交互模块放在一起
    gate/                  # 全局单聊入口，复用对话与进展，展示领域交办
    topics/                # 导航、时间线、输入、工作与审批；main 管理轮询和 SSE
    persons/               # 人物导航、资料和认识编辑
    addresses/             # 场合列表、禁言设置、认识、参与者、默认通知地址与禁言操作
    inputs/                # 跨会话输入筛选、分页与处理 Timeline
    outputs/               # 跨 Topic 输出筛选、生成详情、披露检查与投递状态
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
  plugin/                  # Host / Runner 共用的插件能力
    context.ts             # 执行上下文构造与 verb 参数校验
  connector/client.ts      # Connector 共用访问代理与请求分发
  resource/value.ts        # Resource 编解码、克隆、冻结与比较
  cli/sync-harness.ts      # Harness 包同步命令入口
plugins/personal/
  plugin.ts                # Runner 入口：显式注册各角色与资源协调器
  definitions.ts           # Host 资源定义组装
  aide.ts                  # Host 应用服务：入口、执行 action、恢复与角色工厂装配
  chief/                   # root Input/Batch 选择、接纳、执行与完成事务
    reconcile.ts           # 独立 intake / agent Controller；保持运行中投递能力
    intake.ts              # 从就绪 Input/Batch 选择待办并通知运行中的 Chief
    queue.ts               # 独立 Input 优先级与到期重试选择
    delivery.ts            # 按 Pi 用户消息记录 Chief 投递事实
    workload.ts            # Chief 完成事实与 Review 水位写入
    agent/                 # Host 加载：session 工厂、提示词、工具与背景
  secretary/               # 确定性安排后续工作，无 Agent 和独立 CRD
    reconcile.ts           # 角色注册、资源观察、空检查与过时请求取消
    batching.ts            # 按数量和等待时间选择 Deferred 材料
    maintenance.ts         # 直属容量检查与维护议题
    input.ts               # 维护 Input 创建、去重与准备阶段冷却
    review.ts              # 回顾时间窗口与退避策略
  topic/                   # Topic CRD、树结构、归属、认识依赖与生命周期校验
    model.ts               # 资源字段；Chief / Secretary 状态由 Topic 承载
    review.ts              # Topic 的回顾开关契约
    workload.ts            # 持久工作量 schema 与事实读取
    watch.ts               # Topic 与材料变更的 Watch 映射
    conditions.ts          # summary 汇总调谐
    assignment.ts          # 祖先指纹与直属待办负责人缓存刷新
    organize.ts            # 材料和子树移动的事务约束
    retention.ts           # 安全回收条件
    locator.ts             # Channel / Source 提供 Topic 定位信息的领域契约
    store.ts               # Host 侧 Topic、Input 消费与消息投影
    config.ts              # 以 Topic 为作用域的策略配置及默认值
  gate/                    # 全局问答、领域交办；agent/ 为 Host 工厂与提示词
  route/                   # 初始归属、规则分派；agent/ 为语义路由能力
  weave/                   # 全局 root 关系整理；agent/ 为组织判断能力
  task/                    # 有限目标 CRD 与 Reconcile；agent/ 绑定 Host 工具范围
  routine/                 # 持续职责 CRD 与 Reconcile；agent/ 绑定 Host 工具范围
  work/                    # Task / Routine 共享模型、服务、请求应用与完成回执
    model.ts               # 共用 Work 字段与触发契约，Work 不是独立 CRD
    resources.ts           # Task / Routine 聚合与 Work 查询视图
    status.ts              # Work 阶段、条件与视图到状态的转换
    store.ts               # Host 侧 Work 存取
    agent/                 # 共享 Work 工具
  execution/               # Personal 共用接纳、会话调用与执行收尾
    input.ts               # 接纳资格及 Route / Work 的待办投递
    loop.ts                # 持久接纳、Harness 调用与各类回执恢复
    agent/                 # Host 加载的共享身份、上下文工具与输入读取
  input/                   # Input CRD、路由/投递/办理回执、内部请求证据与成员投影
  batch/                   # Batch CRD、原子归组与封闭成员、接纳及生命周期
  note/                    # 独立事项与 summary、subject/people 索引与容量保留
  person/                  # 人物身份、资料与认识；合并、联系人及消息事实协调
  address/                 # 沟通场合、定位与参与者
  output/                  # Output CRD、披露、投递与展示
  observation/             # Input JobView、原生调用引用与业务证据关联
  source/                  # environment / message / repository / pull-request / requirement 观察
  config.ts                # Personal 配置组装、严格校验与默认值
  identity.ts              # 跨资源确定性身份摘要
  status.ts                # Personal 状态事务组装，调用各资源的条件投影
agents/
  pi/                      # 通用 Pi：SDK、原生工具、会话与 Observation
  background.ts            # 通用的请求背景接口
connectors/                # 全局环境目录、需求平台访问；Forge 配置装配与 repocli 只读能力
packages/common/           # @compforge/aide-common：跨 Host、Plugin、Connector、Channel 的公共错误契约
packages/connector/        # @compforge/aide-connector：通用 Kind、连接描述、外部实现与调用契约
packages/plugin/           # @compforge/aide-plugin：Resource、Controller、Source、Watch 与 Hook 公共契约
tests/                     # 内核、插件、Channel 与 Agent 验证
scripts/install-service.sh # Linux 用户级 systemd 服务
```

## 关键约定

- Gate 是全局信息域与行动范围，暂由 Me 与 Aide 独享，仅双方单聊进入。Gate 是唯一无 parentRef 的 Topic，统一通过 isGateTopic 判断；其直接子 Topic 是独立领域 root，统一通过 isRootTopic 判断；Gate Agent 与 Chief 独立。Gate 跨域读取并交办给领域 Chief，领域承担执行及知识沉淀；原单聊地址承接回复，Gate 汇集对话与交办连续性。Gate 不参与领域 Route 候选、Weave、知识维护与回收，不新建自己的 Work。见 [Gate](docs/personal/gate.md)。
- Aide 是 Me 的独立助理；Gate / Chief / Route / Weave / Task / Routine 是助理内部角色。外部交流不是自动委托，凭证不决定身份；摘要、归并和工作交接保留作者、确认状态与授权范围。身份契约见 [Kernel](docs/kernel.md#助理定位与身份边界)。
- 底座提供 TypeScript controller-runtime，服务 Plugin Operator；Personal 拥有 Input、Batch、Note、Output、Person、Topic、Task、Routine 与业务判断。通用资源和调度不能导入 Personal，应用装配负责安装定义、通信 action 和投递器。
- 修改资源更新、并发、条件写入或协调机制时，先核对 [Resource 更新契约](docs/plugin/resource.md#更新操作与并发) 与 Kubernetes / controller-runtime；通用能力缺口优先在底座解决，再接入业务调用方。明确当前实现与设计目标，不用上层逐点重试或独立版本体系替代缺失的写入语义。
- Host / Runner 不互相导入实现。Runner 经 ResourceClient、Connector API 与 Verb 请求宿主能力，不持有 Store、凭证客户端或 Harness SDK。共享协议放在 src/protocol，公共插件契约放在 packages/plugin。
- 按业务职责在 plugin package 内组织模块：CRD 的模型、事务约束和生命周期就近放置；Chief / Secretary 等独立角色拥有自己的目录，即使状态存储在 Topic。Task / Routine 等兼具角色与资源的模块保持合一。Agent 是角色内部能力，放在角色的 agent/ 子目录并由 Host 工厂加载，Runner 入口不得运行时导入它；跨角色共享执行机制放在 execution/。ResourceDefinition 集中声明 Schema、校验、Printer、索引与保留策略；所有写入在存储事务内校验，提交后通知 Watch。
- 资源身份按插件实例与 namespace 组织，引用固定 UID。同一 Controller 对同一资源串行；主资源纯 status 更新不自动唤醒自身，协作方显式声明 Watch。依赖其它资源的容量资格通过 retention.canEvict 在实际淘汰事务内重查。资源所有者决定能否释放，Host 写入只检查容量并通知独立 GC；GC 对合格 owner tree 原子请求删除，再沿 Controller / finalize 生命周期释放容量。
- Operator 通过 Harness interface / verb 操作原生 agent loop，恢复参数由 Operator 自己保存。Personal 的 status.agent 只是调用参数；Harness verb 不读写 CRD。原生持久化、历史与恢复属于 Harness，实时投影和诊断日志不承担恢复。
- Secretary 是 Topic 上独立的确定性 Reconcile，不调用 Agent；按数量/等待时间准备批次和内部维护 Input，Chief 只关注抽到的非 Deferred Input／Batch，负责工具选择、Agent 执行与结果。Secretary 旁观处理量、等待时间与 pressure，工作产物是 Input／Batch；Immediate／Normal 直接交给 Chief。每个成功投递的 Input／Batch 计一次 Chief 工作量（包括维护 Input），Task／Routine 普通状态不计入。Batch 是独立 CRD，成员关系只保存在 Input.status.batchId；Chief 接纳独立 Input 或 Batch，成员集合在归组后固定，当前仅包含 Deferred；投递事件写 Batch 回执，Input Reconcile 投影成员投递状态，Work 办理回执保持独立。职责见 [Secretary](docs/personal/secretary.md)，批次契约见 [Batch](docs/personal/input.md#batch)。
- Route、Chief、Task、Routine、Weave Agent 只由各自对应的 Reconcile 触发，包括 prompt、steer 与 followUp；协作组件和 Agent 工具通过资源变化协作，不直接触发其它角色。
- Input、Task、Routine 通过 status.topic 保存唯一且可调整的材料 Topic UID 引用；Input.assess.topic 保存未领取待办的最终一致负责人缓存，领取后保留实际执行归属，Input.assess 保存 Chief 接纳 executionId 及投递时间，自动 prompt / steer / followUp 在提交前通过资源事务竞争接纳；Topic 保存 Chief 执行与原生会话。Route 保存首次路由回执，Chief 在树内整理归属，Weave 只改变父子关系。
- 接纳回执、Input 处理完成、工作目标达成与 Output 送达是独立事实。持续 Agent 使用原生 followUp / steer；工具回执确认业务完成。Chief 未提交终态结果的 Input／Batch 在执行释放后重试，已有终态结果保持不变；Work 的副作用恢复由其自身契约负责。
- Channel / Source 通过绑定 Definition 的入口形成 Input，正文保存事实，证据留在 observation。路由统一归 Route，Default Topic 由系统按需创建并维护，只兜底，不提供手动切换；Input.status 的 route / assess / handle 是处理事实，消费者按索引查询。
- Person 保存人物身份与认识，联系地址由 scoped identities 和 Address locators 查询推导，不保存 spec.addresses；已配置 Lark Channel 的人物单聊首次发现允许发言，后续发现保留禁言。Me 是可选标记，与访问凭证独立。Input.sender / Output.receivers 引用 Person，Input.source / Output.target 使用 Address；来源 topicKey、通信地址和授权分别判断。
- 长期认识保存在 summaryOf 指向 Topic、Task、Routine、Person、Address 的 Note 中，对象不保存 summary 字段；summaryRevision 仅为派生内容指纹。summaryOf 按对象 UID 索引，每个对象至多一份活跃摘要；目标对象存在时保护活跃摘要，目标实际移除后按普通容量回收，同名重建不算原对象。普通 Note 按稳定 ID 保存事实性知识或可复用的方法，Chief 初记可暂缺 nature，curate 核对保留的版本时归类，spec.name 是可维护的名称；Prompt 注入普通 Note 目录，正文按 read_note 读取，subject 关联 Topic/Work、people 关联人物，recent 仅作查询投影，完整发现走 list_notes，事项归位走 move_note；nature 区分 semantic / procedural，普通与 summary 共用 maxChars 软预算。Topic 的 maxNotes 与超长 Note 驱动 curate 整理，split_note 原子拆出普通 Note；合并时先确认目标写入，再 prune_note 来源或 retire_note 整篇；退役不改正文/引用，保留的 Stream 固定其证据生命周期；两者独立写入，办理报告只确认业务状态与 Input 回执。结构化目标与身份各自保留。用户修订直接进入 Person 的同一个 summary，Agent 按最新版本继续维护。
- Topic tree 表达对主题关系与职责层次的理解，并决定 root Chief 的处理范围。整理以关联价值和用户目标为依据，容量阈值安排整理时机；压缩保留影响判断的事实、分歧与未决问题。认知沉淀主线见 [Personal](docs/personal/README.md#从-input-到认识与成果)。
- Task 承担有限目标，Routine 承担持续职责。领域 Agent 与通用 Pi 共用适配，工具按资源 UID 和当前 execution 绑定；业务请求与消费凭据落在 Input。Chief / Work 通过 say 产生独立 Output，report 与 say 分别提交；普通回答是新 Input，原生权限由独立 Approval 处理。
- Forge 的 Repository / PullRequest 模型复用 harness-common，平台读取、增量发现完整性、不透明游标与 HTTP 约束由 repocli lib 承担；Aide Connector 负责配置与调用路由，Personal RepositorySource 负责清单缓存与观察任务交接，PullRequestSource 负责 PR 基线、检查点与 Input。契约见 [Forge](docs/connector/forge.md)。
- Connector kind 与 version 是独立字符串，connectors 直接按 name 声明；领域 interface 定义操作契约，安装入口按 name 注册实现，配置不使用 type 或 packages/instances 包装；Plugin 与 verb 按 kind 发现 Connector 并通过同一客户端调用，私有配置和凭证不进入 Runner。Source 继续复用 Plugin 机制，Connector 是否作为 Resource 独立演进。契约见 [Connector 扩展](docs/connector/extensions.md)。
- Connector 按外部系统或服务组织操作与适配；一个 Connector 可支持多个业务 Source，Source 可细到单个业务 Resource，按观察生命周期独立保存状态与调度。外部频控的策略、数值和配额范围由 Connector / Channel 适配并复用共享客户端；Output 只消费安全错误与重试时间，使用已有持久队列协调。边界与建设状态见 [Connector 与 Source](docs/connector/README.md)。
- plugins.<plugin>.sources 声明观察策略，形成 Input 的 Source 先保存 Input 再推进水位。所有模块在自己的 config.ts 声明契约，启动时解析一次；显式值优先于默认值，空数组不回退，运行中不重读配置。命名 Channel 通过配置文件维护，重启生效；defaultAddress 保存具体 AddressRef，Web 选择立即用于新通知；默认 say 联系 Me，不依赖 Topic 的来源地址或私聊历史。
- Web 按页面组织，入口管理轮询与 SSE 生命周期，交互模块持有自身状态；共用浏览器能力放在 web/shared，展示类型经 type-only import 使用。Channel 通过 Output 实际 Stream 展示进展，不旁路投递 Harness 投影。
- 根目录 VERSION 是产品版本，每次提交递增一次，默认 patch。设计文档描述当前模型与 why，详细契约各有主说明位置，其它文档用链接引用；代码意图标记链接到对应主题。

## References

- [文档导航](docs/README.md)：使用、开发与验收的阅读入口。
- [Kernel](docs/kernel.md)、[Plugin](docs/plugin/README.md)、[Resource](docs/plugin/resource.md)：底座边界、协调、定义、事务与容量；[公共契约](packages/plugin/README.md)。
- [Personal](docs/personal/README.md)：认知沉淀、对象与完整流程；[Input](docs/personal/input.md)、[Address](docs/personal/address.md)、[Note](docs/personal/note.md)、[Route](docs/personal/route.md)、[Topic](docs/personal/topic.md)、[Output](docs/personal/output.md)。
- [Topic](docs/personal/topic.md)：资源、归属交接、认识依赖与回收；[Secretary](docs/personal/secretary.md)：待办准备与维护调度；[Weave](docs/personal/weave.md)：全局主题关系。
- [Chief](docs/personal/chief.md)：Input/Batch 接纳、执行、完成，以及提示词、上下文与记忆；[Person](docs/personal/person.md)；[Work](docs/personal/work.md) 说明 Task、Routine 与 Ongoing。
- [Harness](docs/harness/README.md)、[Pi](docs/harness/pi.md)：通用执行契约与原生适配。
- [Channel](docs/channel/README.md)：[Web](docs/channel/web.md)、[Lark](docs/channel/lark.md)。
- [Connector 与 Source](docs/connector/README.md)：[Forge](docs/connector/forge.md)、[环境](docs/connector/environments.md)、[Lark 消息](docs/connector/lark-messages.md)、[需求平台](docs/connector/requirements.md)。
- [Observation](docs/observation.md)：Input JobView、原生 SessionView、请求补录与证据缺口。
- [配置](docs/configuration.md)、[部署与诊断](docs/deployment.md)、[真实验收](docs/e2e.md)。

- Output.spec 保存发送意图，status.disclosure 保存检查，status.delivery 保存实际目标、Stream 与接收者；密级拒绝在同一 Output 上转告 Me。同一 Output Reconciler 负责检查、投递和重试，Channel 只提供具体目的地的发送能力，进度卡不展示未经披露检查的私有推理。见 [披露边界](docs/personal/disclosure.md)。

## 定向验证

根目录 `make test` 接收空格分隔的 `TEST_FILES`，路径相对于仓库根目录；未传或空值执行全套测试。devloop 先选择受影响的 Component，再自动传入文件列表，通常不手动指定。Bun 接收明确文件路径，避免 `npm test -- ...` 在原有 `tests` 参数之外追加筛选条件导致仍执行全量。

根目录 `make lint` 按 tsconfig 检查整个 TypeScript Component。`packages/plugin` 使用自己的 tsconfig；没有包内测试，`make test` 委托根目录现有的 `plugin-*`、`runner-*`、`resource-*` 契约集成测试，不重新执行 Personal、Channel 与 replay 等整套测试。根目录 `make test` 仍保留完整测试。未配置 formatter，因此不添加空操作的 `make fix`。

- Address 是 Personal 的独立沟通场合；Input.source / Output.spec.target 引用其 UID，平台 locators 留在 Address，回复消息坐标留在 Input/Output。status.people 累积已知参与者，不声明名单完整。muted 约束原文、进度卡和 Channel 错误提示；Output Reconcile 对 Immediate Input 在原地址发送固定禁言提示，其它禁言 Output 转投 Me 的 defaultAddress。Chief 提交 raw Output，Agent 不自行解除禁言。
