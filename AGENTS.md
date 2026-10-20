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
  channel/                 # Lark 适配、共享消息协议与执行投影
  host/                    # 主进程：持久化、交互与执行事实
    input/                 # 独立 Input 事实与内置资源投影
    plugin/                # Resource / Controller / Source / Watch / verb
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
  aide.ts                  # Personal 服务：Chief 会话绑定、输入与恢复
  plugin.ts                # 插件入口：注册 Chief / Source / Task / Routine
  input.ts                 # Chief Input 路由与可恢复的多会话追加
  conversation-model.ts    # Personal Conversation CRD
  conversation-trigger.ts  # Conversation 定时触发配置
  conversation-store.ts    # 会话投影与消息 outbox
  chief.ts                 # 按 Conversation 消费 Input、续接问答
  source.ts                # 需求观察、水位和调度
  message-source.ts        # Lark 单聊、群内 @ 观察、水位和短期讨论跟进
  message-context.ts       # IM 有界上下文、话题根消息与缺口
  environment-source.ts    # Workload 观察、基线和变化 Input
  environment-config.ts    # 从环境声明派生观察范围
  resources.ts             # 独立 Task / Routine 契约与 Work 视图
  task.ts                  # 有限目标 Reconcile
  routine.ts               # 持续职责 Reconcile
  execution.ts             # Personal 共用执行、结果校验与记录
  work.ts                  # 会话范围内 Work 创建、追加输入与删除
  work-input.ts            # Work Reconcile 消费输入与应用请求
  store.ts                 # 宿主端工作存取、消息与去重投影
agents/
  pi/                      # 通用 Pi Agent：SDK、原生工具与会话
  chief/                   # Personal 提示词、Work / 问答 / Connector 工具
connectors/                # 全局环境目录、Meego / GitHub / GitLab 访问与数据映射
packages/plugin/           # @compforge/aide-plugin 公共契约
tests/                     # 内核、插件、Channel 与 Agent 验证
scripts/install-service.sh # Linux 用户级 systemd 服务
```

## 关键约定

- 根目录 `VERSION` 是产品版本。每次提交同步递增，默认 patch，同一提交只递增一次。
- Host / Runner 不相互导入实现。共享模块按职责放在 `src/`，不依赖两端实现。Runner 经 Resource API、Connector API 与 verb 请求宿主能力，不持有宿主 Store 或 Harness SDK。
- Connector 由 Host 从 `config.yaml` 装配，所有 Plugin 共用；环境声明直接位于 `connectors.environments.<name>`。环境发现只读配置，不代表连通性、健康或操作授权；需求 watch 策略归 `plugins.personal`；环境 Source 从已配置且可观察的 Environment 自动派生。
- 各模块在自己的 config.ts 声明配置契约，启动装配解析一次，运行实例消费有效配置；进程期间不重读配置文件，修改后重启生效。配置遵循显式值大于默认值，空数组不回退；来源与字段归属见 `docs/configuration.md`。`harnesses.pi` 与 `harnesses.chief` 分别声明模型与能力包，包按 Harness 显式同步；内置装配只加载声明包中的 skills。
- Session 是持久执行作用域，保留 Ledger、Lane、Turn 与恢复绑定；CoreSession 负责进程期装配。Session 统一位于 `$AIDE_HOME/sessions/<id>/`，不按 project / cwd 分组。逻辑 ID 的目录编码由 SessionStore 负责。启动时恢复全部 Session 的工作和 Source；watch 仅装配到所属 Session。cwd 只是执行环境，改变时保留 Aide 历史并清空原生恢复绑定；插件私有数据仅有 global、session、instance 三个目录作用域。
- Input 是 Core 内置资源，可带目标 sessionId；Conversation 是 Personal CRD，保存 Input 引用与各自消费状态。Channel / Source 不依赖 conversationId。Chief 先 Reconcile Input 路由，再 Reconcile Conversation 干活；路由计划持久化后以资源 Update 追加，不新增路由 Verb。跨 Session 写入经过目标 ResourceClient 与 Watch。
- Chief 对已有 Work 使用 append_input 投递事实或请求，输入队列与消费进度由 Work 持久保存；Task / Routine Reconcile 决定目标与执行状态，Chief 保留创建和删除资源的能力。
- Task / Routine 各有独立资源身份与 Reconcile；Work 是业务统称。Task 有完成条件，Routine 承担持续职责，执行时长和次数不决定类型。类型转换组合创建、暂停或删除，目标工作拥有新 id。
- Harness 原生 Session 由各 Harness 管理并使用其默认目录；Aide 按 Session × Lane × Target 保存原生身份和 Adapter 的 resumeState。
- 业务进展以资源和执行事实为准，记忆辅助理解与判断。记忆由 Harness 组合开源实现；Chief 内置 pi-hermes-memory，Personal 不感知记忆能力，Core 不新增记忆存储或协议。扩展生命周期由 PiAdapter 驱动，原生配置与共享范围见 Chief 文档。
- `pi` 提供通用 Agent，`chief` 加入 Personal 工具，两者复用 PiAdapter。通用 Pi 不依赖 Personal，Chief 的 WorkService 由宿主绑定范围；默认 Work 执行由根级 `defaultHarness` 选择，缺省为通用 Pi。
- Source 先提交持久 Input 再推进观察水位。Input 独立保存，Conversation 内的消费状态、业务回复与去重记录原子提交，不能用投递失败重新触发业务执行。
- Harness 执行结束、业务目标完成和消息送达分别记录。业务 Controller 结合完成条件与外部证据解释结果，Core 保存执行事实。中断可能已经产生外部副作用，保留待核对状态，不自动重放。
- 所有业务资源写入经过 Core ResourceClient，通知相关 Watch。主资源纯 status 更新不自动唤醒自身，需感知状态变化时声明 Watch。Verb 是 Controller 动作出口，其它组件可直接调用 Core 服务。
- 执行上下文显式携带主资源和可选 Conversation/Input 关联；Channel 不通过 Chief Target 推导问题和进度归属。
- Personal 将新发生的事归入能承接它的上下文：Conversation 承载话题，Task 承载有限目标，Routine 承载持续职责与当前轮次。Chief 优先关联已有 Work，再按需要创建；各 Reconcile 根据历史与新事实推进、更新、沟通、等待或忽略。详见 `docs/plugin/personal.md`。
- trigger 归属于 Conversation；新 Input 与定时回顾唤醒同一话题。Personal / Chief 决定回顾和主动沟通策略，Core 提供通用定时唤醒与恢复机制。say 保存普通 Message，不创建 Interaction；记忆中的偏好不自动成为执行委托。
- Chief 问答复用 Core Interaction；Task / Routine 的 waiting 是业务持久状态。两者的跨重启行为见 Personal 文档。
- Channel 进展消费既有执行投影与 Ledger，Web 使用 AgentUE。进度不写入业务 Message，不另建轨迹存储。
- `npm run check` 验证类型与测试。真实 Runner / SDK 加模拟外部服务不等于真实模型、CLI 或 Lark 已验证。

## References

- [Kernel](docs/kernel.md)：整体机制、输入对象、执行事实与恢复。
- [Plugin](docs/plugin/README.md)：插件运行、资源生命周期与调度；[公共契约](packages/plugin/README.md)。
- [Personal](docs/plugin/personal.md)：Chief、Task / Routine 和业务决策。
- [Harness](docs/harness/README.md)：通用执行契约；[Pi](docs/harness/pi.md)、[Chief](docs/harness/chief.md)。Chief 文档承载提示词、上下文与记忆优化方向。
- [Channel](docs/channel/README.md)：Web 与 Lark；[Web](docs/channel/web.md)、[Lark](docs/channel/lark.md)。
- [Connector 与 Source](docs/connector/README.md)：关注范围、连接器配置和覆盖限制。
- [部署与诊断](docs/deployment.md)、[真实验收](docs/e2e.md)。
