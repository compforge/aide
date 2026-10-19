# AGENTS.md

## 项目定位与边界

Aide 是小型、自托管的 personal agent。Web / Feishu Channel 与 Source 提交输入，Personal 插件的 Chief 负责判断，普通问题直接回复，需要跟进时操作 Task / Routine。Host / Runner 提供可供其它插件使用的运行机制。

按绿地视角开发，先走通个人助手场景，不建设账号权限中心、共享 SDK 或多实例平台。业务判断放在 Personal 与 Chief Agent；修改通用机制前先说明具体需求和现有能力缺口。

## 代码地图

```text
src/
  main.ts                  # 装配 Channel、Personal 与 Harness
  channel/                 # Web / Feishu 适配，消息与执行投影
  host/                    # 主进程：持久化、调度、交互与执行
    conversation/          # 内置 Conversation / Input / Message
    plugin/                # Resource / Controller / Source / Watch / verb
      runner/              # 宿主侧 Supervisor / IPC Client / 注册代理
    channel/               # Session 执行组件装配，不是 Web/Feishu 适配器
    controller/            # HarnessInput / Queue / Turn 执行协调
    harness/               # Harness 注册、Adapter 与提供方协议
    store/                 # Session、Ledger 与执行投影
  runner/                  # Plugin 子进程入口与回调执行
  protocol/                # Host / Runner 共用 IPC 与 verb 契约
  plugin-context.ts        # 共用上下文构造与 verb 参数校验
plugins/personal/
  aide.ts                  # 宿主装配、Chief 会话绑定、输入与恢复
  plugin.ts                # 插件入口：注册 Chief / Source / Task / Routine
  chief.ts                 # 按 Conversation 消费 Input、续接问答
  source.ts                # 需求观察、水位和调度
  resources.ts             # 独立 Task / Routine 契约与 Work 视图
  task.ts                  # 有限目标 Reconcile
  routine.ts               # 持续职责 Reconcile
  execution.ts             # Personal 共用执行、结果校验与记录
  work.ts                  # 会话范围内 Work CRUD 与业务规则
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
- Connector 由 Host 从 `config.yaml` 装配，所有 Plugin 共用；环境声明直接位于 `connectors.environments.<name>`。环境发现只读配置，不代表连通性、健康或操作授权；Personal watch 策略归 `plugins.personal`。
- Conversation / Input / Message 是 Host 内置对象。Channel / Source 决定 conversationId，Chief 按会话串行消费输入；会话分组不是权限边界。
- Task / Routine 各有独立资源身份与 Reconcile；Work 是业务统称。类型转换组合创建、暂停或删除，目标工作拥有新 id。
- `pi` 提供通用 Agent，`chief` 加入 Personal 工具，两者复用 PiAdapter。通用 Pi 不依赖 Personal，Chief 的 WorkService 由宿主绑定范围；默认 Work 执行使用 Codex。
- Source 先提交持久 Input 再推进观察水位。输入状态、业务回复和去重记录按现有原子提交边界保存，不能用投递失败重新触发业务执行。
- Harness 结束不等于业务目标完成，Personal 校验结果后决定终态。中断可能已经产生外部副作用，保留待核对状态，不自动重放。
- Chief 问答复用 Core Interaction；Task / Routine 的 waiting 是业务持久状态。两者的跨重启行为见 Personal 文档。
- Channel 进展消费既有执行投影与 Ledger，Web 使用 AgentUE。进度不写入业务 Message，不另建轨迹存储。
- `npm run check` 验证类型与测试。真实 Runner / SDK 加模拟外部服务不等于真实模型、CLI 或飞书已验证。

## References

- [Kernel](docs/kernel.md)：整体机制、输入对象、执行事实与恢复。
- [Plugin](docs/plugin/README.md)：插件运行、资源生命周期与调度；[公共契约](packages/plugin/README.md)。
- [Personal](docs/plugin/personal.md)：Chief、Task / Routine 和业务决策。
- [Harness](docs/harness/README.md)：通用执行契约；[Pi](docs/harness/pi.md)、[Chief](docs/harness/chief.md)。Chief 文档承载提示词、上下文与记忆优化方向。
- [Channel](docs/channel/README.md)：Web 与 Feishu；[Web](docs/channel/web.md)、[Feishu](docs/channel/feishu.md)。
- [Connector 与 Source](docs/connector/README.md)：关注范围、连接器配置和覆盖限制。
- [部署与诊断](docs/deployment.md)、[真实验收](docs/e2e.md)。
