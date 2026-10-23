# 环境目录与 Workload 观察

Connector 声明访问坐标并读取运行事实，Personal Source 保存观察状态并提交 Input。

## 配置

全局文件的选择、字段优先级和默认值规则见 [配置](../configuration.md)。Connector 声明由 Host 在启动时装配，修改后重启。

环境直接声明在 `connectors.environments.<name>`，配置 key 就是环境身份。Personal 的观察范围位于 `plugins.personal.sources.environments`：

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
plugins:
  personal:
    sources:
      environments:
        targets:
          - environment: dev
            namespaces: [app]
        intervalMs: 300000
```

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

环境 Source 按配置目标建立观察资源，维护基线与调度，不随聊天数量重复采样。变化生成不带话题 sessionId 的 Input，交给 Route 判断归属。关闭聊天 trigger 不关闭环境观察；修改配置后重启生效，策略变化会静默建立新的基线，移除的策略停止观察。

观察以 namespace 内的 Deployment、StatefulSet、DaemonSet 和无 Controller 的独立 Pod 为范围，ReplicaSet 用来追溯 Pod 到 Deployment 的归属。
归属按 ownerReference 的 Controller UID 解析，不猜 Pod 名称前缀。Job/CronJob、独立 ReplicaSet 和自定义 Controller 的 Pod 不在此范围。
Workload 身份是环境、namespace、kind、name；UID 表达同名资源的新一代实例。这里没有把 Kubernetes Service 当作 quality-harness 的业务 Service，也不凭资源名推断 Component 归属。

镜像、generation、副本数、Pod UID、容器重启数、最近退出原因、运行状态和就绪状态参与比较；资源列表顺序、resourceVersion 和时间戳不产生变化。
只保存这些运行事实，不把完整 manifest、环境变量或 Secret 内容写入 Input。一次轮询的所有变化合成一个 `workload.changed` 观察，包含各 Workload 的 before/after；新增只有 after，移除只有 before。

首次成功采样静默建立基线，不向 Chief 提交历史变化。后续变化先保存 Input，再推进基线；若在二者之间中断，先用已保存 Input 恢复那次基线，再继续观察。
输入身份包含观察序号，因此 A→B→A→B 会保留两次 A→B。读取失败、分页不完整或 Pod 归属采样不完整时保留基线，记录错误并按间隔重试，不把采集失败当作资源删除。

这是周期采样的状态差异，不是 Kubernetes 审计流：不能覆盖两次采样之间已经消失的短暂变化，也不保证跨资源列表的原子快照。
Pod 替换或镜像变化是事实，不能据此断言有人发布，更不能猜测操作者。Chief 结合目标会话的近期关注、已有委托和记忆判断是否 `say`、更新 Work 或静默忽略；Source 不直接通知用户、不创建 Task/Routine。

## 验证

环境测试使用模拟 Kubernetes HTTP 服务验证归属、变化归一和采样失败，再通过真实 Runner 验证 Connector → Source → Input。模型与集群仍是替身；声明存在或采样成功不证明发布、业务健康或操作授权。
