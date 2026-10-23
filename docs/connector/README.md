# Connector 与 Source

Connector 是 Aide Host 提供的外部系统访问能力；所有 Plugin 和 Chief 共用读取接口，评论发送由 Host 消费 Output。Host 加载配置、创建连接器并持有提供方客户端；Plugin Runner 通过现有 IPC 查询，不自行读取全局配置。`connectors` 声明访问能力，`plugins.<plugin>.sources` 定义关注范围和观察策略，Chief 判断变化是否值得通知或推进。只声明 Connector 不启动观察。

支持环境目录、Kubernetes Workload 采样、需求平台、GitHub / GitLab PR 和 Lark 消息。环境目录读取声明，Workload 采样读取运行态；需求平台通过提供方 CLI 读取需求与评论，按 Output 投递答复，详见 [需求平台接入](requirements.md)；Forge 使用统一 HTTP 客户端。Lark 通过 `lark-cli` 用户身份读取，接入与观察策略见 [Lark 消息观察](lark-messages.md)。Connector 不创建 Work，也不代替用户决定下一步。

## 配置与所有权

全局文件的选择、字段优先级和默认值规则见 [配置](../configuration.md)。Connector 声明由 Host 在启动时装配，修改后重启。

环境直接声明在 `connectors.environments.<name>`，配置 key 就是环境身份。需求平台 / Forge / Lark 连接信息也放在全局 `connectors`；Personal 的环境、Lark 与需求观察策略属于 `plugins.personal.sources`：

```yaml
connectors:
  environments:
    dev:
      kind: kubernetes
      description: 开发联调环境
      aliases: [开发环境]
      kubeconfig: ~/.kube/dev
      context: dev
    devbox:
      kind: host
      description: Linux 开发机
      host:
        name: devbox
        transport: ssh
        address: devbox
  forges:
    github.com:
      type: github
      # 优先从服务环境的 GITHUB_TOKEN / GH_TOKEN 读取
    gitlab.example.com:
      type: gitlab
      # 优先从服务环境的 GITLAB_TOKEN 读取
plugins:
  personal:
    sources:
      environments:
        targets:
          - environment: dev
            namespaces: [app]
        intervalMs: 300000
```

需求 Connector 的字段与观察配置见 [需求平台](requirements.md)。

## Environment 的含义

复用 `@compforge/harness-common` 的 Environment / Host 契约：Environment 是命名的部署目标，Host 是目标所在的机器。Aide 添加描述、别名以及 Kubernetes 的访问坐标。

- `name` 取配置 key，名称和别名共享唯一命名空间，冲突在启动时拒绝。查别名返回规范 name；不存在的名称报错。
- `kind` 支持 `kubernetes`、`host`、`generic`；省略表示通用环境。
- `host` 可省略，语义沿用当前执行主机；显式 local Host 只有 name / transport，SSH Host 还需 address。Kubernetes 环境也可声明 Host。
- Kubernetes 必须显式配置 kubeconfig；context / namespace 可省略，省略仅表示尚未声明。发现阶段不选择默认 kubeconfig、context 或 namespace。
- 路径原样保留，尤其远端 Host 的 `~` 不按本机 HOME 展开。读取声明不检查文件、不连接 SSH / Kubernetes、不报告健康或可达。
- 环境声明拒绝未知字段，不接收 token、密码或 kubeconfig 内容。kubeconfig 路径和 Host address 可在详细查询中返回。

Chief 的 `list_environments` 返回 name、kind、description、aliases 摘要；`read_environment({name})` 返回完整声明。`list_connectors` 同时列出环境、需求和已启用的 Forge。工具结果是声明事实，不能作为已获得操作授权或执行成功的证明。

所有 Plugin 使用相同的类型化能力：

```ts
const environments = await context.connectors.environments.list();
const dev = await context.connectors.environments.get("开发环境");
// dev.name === "dev"
// 已配置名为 work 的需求 Connector 时，可按页查询：
const requirements = await context.connectors.requirements.list("work");
```

目录不绑定 Personal，也不生成 Resource、Task、Source 或持久观察状态。宿主公共接口不返回提供方凭证；这不是插件安全隔离机制，Runner 仍使用服务用户的执行身份。

Workload 采样复用 `@compforge/harness-toolbox` 的原生 Kubernetes ResourceAccess 和 Pod 解析。每次采样建立有界访问范围，结束或失败时取消剩余请求；全局目录不永久持有所有环境的客户端。

## Environment 变化

`connectors.environments.workloads(name, namespace?)` 返回规范环境名、namespace、采样时间与 Workload 快照。
namespace 优先取参数，否则取环境声明；两者都缺失时拒绝采样。读取使用 Aide 所在机器的 kubeconfig，支持 `~/` 路径。
SSH Host 不作为本地配置使用，Workload 采样要求本地 Kubernetes 访问。每次采样总超时 25 秒，单请求 10 秒，并发 2，单个列表上限 8 MiB。

Personal 按 `sources.environments.targets` 中的环境和 namespace 生成观察资源，默认每五分钟采样一次；每个环境可以观察多个 namespace。
目标引用 Connector 的名称或别名，解析后以规范名称保存。namespace 来自 Source 策略，不从 Connector 的查询默认值推导。
未声明环境 Source 或 `targets: []` 时不启动观察；显式引用不存在的环境、Host / generic 环境、SSH 访问或重复目标时启动报错。

环境 Source 统一在 `source:environments` Session 中维护基线与调度，只观察一次，不随聊天 Session 数量重复采样。变化生成不带目标 sessionId 的 Input，Chief 根据已有会话近期关注与 Work 判断去向。关闭聊天 trigger 不关闭环境观察；修改配置后重启生效，策略变化会静默建立新的基线，移除的策略停止观察。

观察以 namespace 内的 Deployment、StatefulSet、DaemonSet 和无 Controller 的独立 Pod 为范围，ReplicaSet 用来追溯 Pod 到 Deployment 的归属。
归属按 ownerReference 的 Controller UID 解析，不猜 Pod 名称前缀。Job/CronJob、独立 ReplicaSet 和自定义 Controller 的 Pod 不在此范围。
Workload 身份是环境、namespace、kind、name；UID 表达同名资源的新一代实例。这里没有把 Kubernetes Service 当作 quality-harness 的业务 Service，也不凭资源名推断 Component 归属。

镜像、generation、副本数、Pod UID、容器重启数、最近退出原因、运行状态和就绪状态参与比较；资源列表顺序、resourceVersion 和时间戳不产生变化。
只保存这些运行事实，不把完整 manifest、环境变量或 Secret 内容写入 Input。一次轮询的所有变化合成一个 `workload.changed` 观察，包含各 Workload 的 before/after；新增只有 after，移除只有 before。

首次成功采样静默建立基线，不向 Chief 提交历史变化。后续变化先保存 Input，再推进基线；若在二者之间中断，先用已保存 Input 恢复那次基线，再继续观察。
输入身份包含观察序号，因此 A→B→A→B 会保留两次 A→B。读取失败、分页不完整或 Pod 归属采样不完整时保留基线，记录错误并按间隔重试，不把采集失败当作资源删除。

这是周期采样的状态差异，不是 Kubernetes 审计流：不能覆盖两次采样之间已经消失的短暂变化，也不保证跨资源列表的原子快照。
Pod 替换或镜像变化是事实，不能据此断言有人发布，更不能猜测操作者。Chief 结合目标会话的近期关注、已有委托和记忆判断是否 `say`、更新 Work 或静默忽略；Source 不直接通知用户、不创建 Task/Routine。

## 观察流程

需求 Source 按 `sources.requirements` 中的 Connector 引用和负责人范围读取近期摘要，比较实体身份与观察指纹。项目与平台字段映射由 Connector 声明；负责人筛选由 Source 通过查询参数传入，同一 Connector 可供不同关注范围复用。新观察先持久化为 Input，再推进水位；中断后的重试依靠输入身份去重。首次发现已完成或关闭的需求不生成输入；已跟踪需求结束或转交时仍生成最后一次变化，并读完当前评论窗口。

需求 watch 默认使用 `source:<watch-id>` 作为 sessionId，也可指定已知聊天 Session。Source 只填写 sessionId，不填写 conversationId；Personal 管理该 Session 的 Conversation。watch 只装配到所属 Session，创建其它聊天不会重复轮询。Host 校验负责人范围后下发有效配置。Source 不直接调用模型或创建 Task，Chief 根据已有委托选择询问、CRUD Work 或静默忽略。

需求平台的“我名下”按指定负责人字段中的稳定 user key 匹配，不按参与人或显示名。Connector 默认映射当前节点处理人；项目若用单独的需求负责人字段，配置 `assigneeField`。Source 的每个需求观察项必须声明非空 `userKeys`，避免意外观察整个项目。按需查询可用 `assigneeUserKeys` 筛选，不传时不继承 Source 的负责人策略。提供方 CLI 单命令超时 20 秒、输出上限 4 MiB。

Forge 的配置 key 是逻辑身份，`api_host` 可以覆盖 API 域名，`uids` 可选过滤 PR 作者。`GITHUB_TOKEN` / `GH_TOKEN`、`GITLAB_TOKEN` 优先于文件 token；没有凭证的 Forge 不启用。服务环境需能找到提供方 CLI 并访问其登录态，不能只在交互 shell 中配置 PATH。

Lark 目标为 `lark:<app-id>:<chat-id>`，可从入站日志的 sessionId 获取。机器人需要已经收到过该单聊的消息，才会向其投递。Chief、Task 与默认 Pi Routine 的模型分别由 `harnesses.chief`、`harnesses.task` 和 `harnesses.pi` 配置，缺省时沿用 Pi 原生配置。

需求平台按固定时间窗口分页观察需求和评论，检查点与待提交 Input 可跨重启恢复；身份、投递和覆盖边界见 [需求平台](requirements.md)。Forge 当前供 Chief 查询 PR 状态与评论，没有定时 Source。

框架的调度见 [Plugin](../plugin/README.md)；决策策略见 [Personal](../plugin/personal.md)。

## 验证

配置测试覆盖名称与别名冲突、结构错误、缺失文件和启动快照；真实 Runner 测试验证多个插件共享 Connector、跨 IPC 查询和错误传播。真实 Pi SDK 配合模拟模型服务验证 Chief 环境工具，并回归 Source → Chief → 用户决定 → Work 链路。

环境测试通过模拟 Kubernetes HTTP 服务验证 toolbox 原生访问、归属和变化归一化，通过真实 Runner 验证 Connector Verb → Input → Chief、会话隔离及重启恢复；模型与集群仍是替身。

需求测试覆盖负责人筛选、观察水位与去重；Forge 测试覆盖协议映射、评论、限流与错误行为。测试未连接真实环境、账号或模型，不能证明网络可达、部署健康或提示词效果。
