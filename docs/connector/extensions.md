# 外部 Connector 扩展

Connector Kind 定义一组操作，外部包提供实现，Host 将配置装配为工作连接。调用方按 Kind 发现连接，使用类型化客户端；新增 Kind 不修改 Host/Runner 的 operation 列表。Connector 当前由配置和注册表管理，是否持久化为 Resource 独立演进。

## 边界

`packages/connector` 提供 Kind、引用、描述、包定义与客户端契约；`src/host/connector` 实现加载、注册、调用与关闭。内置 Connector 与外部包使用同一个注册表，Plugin 回调、Reconcile 与 verb 共享相同连接。Source 继续在 Plugin 中声明业务资源、观察和 Input 交接，不单独发布 Source SDK。

包入口只在 Host 加载，拥有私有配置及环境访问。Runner 获得不含凭证的描述和方法结果。外部模块是显式安装的受信任代码；进程职责边界不构成运行不可信代码的安全沙箱。

## 配置

```yaml
connectors:
  packages:
    - "@example/aide-connectors"
    # 本地入口也可配置为 ./connectors/company.ts
  instances:
    work:
      type: example-tickets
      config:
        tokenEnv: TICKETS_TOKEN
      maxConcurrentCalls: 4
      maxQueuedCalls: 64
    personal:
      type: example-tickets
      config:
        tokenEnv: PERSONAL_TICKETS_TOKEN
```

packages 引用已安装的 npm 包或本地模块，模块默认导出 ConnectorPackage。本地路径相对于 Aide 配置文件目录；npm 包从该目录的模块解析路径查找。Host 不接受网络模块 URL、不自动安装模块，也不在 Runner 中加载凭证客户端。

instances 的 key 是连接名称，type 是包注册的实现标识；enabled 默认为 true。不同名称可以使用同一个 type，相同 Kind 也可以由不同包实现。名称在 Kind 内唯一；实现 type 在已加载包内唯一。重复注册、缺失方法、契约冲突、配置校验或创建失败均明确报错，已创建连接会回滚关闭。

config 的结构由实现自己的 schema 校验。凭证建议通过配置中的环境变量名称引用，由 create(context, config) 在 Host 调用 context.env() 解析；不要把凭证作为方法参数传给 Source。环境依赖在创建阶段解析，其值与包版本、实现和私有配置共同生成不可逆的访问 revision，描述中不返回原值。

GitHub/GitLab 也可以直接通过同一个实例入口配置，type 分别为 github/gitlab，config 包含 host、可选 forge 身份和 tokenEnv；缺省 tokenEnv 沿用 GITHUB_TOKEN/GH_TOKEN 或 GITLAB_TOKEN。既有 connectors.forges 声明继续装配到同一注册表。例如：

```yaml
connectors:
  instances:
    personal:
      type: github
      config:
        host: github.com
        tokenEnv: GITHUB_TOKEN
```

## 发现与使用

Kind 声明稳定标识、契约版本和异步方法签名，可以为参数 tuple 和结果补充运行时校验。包可以注册任意 Kind，无需 Aide 核心枚举。

Plugin 使用 context.connectors.list(Kind) 获取所有符合契约版本的连接，再用 get(Kind, description) 取得类型化客户端。Reconcile 通过 execution.verbs.connectors({timeoutMs}) 使用同一 API，调用仍进入现有 verb 诊断和恢复机制。

发现得到的连接包含 name、kind、version、revision、方法列表和显式公开的 metadata。引用绑定具体访问 revision 和契约版本；连接替换后旧引用报错，调用方重新发现，不自动切换账号。注册描述只说明连接已装配，远端权限与可用性由实际调用确认。

Source 可以遍历同 Kind 的所有连接；各连接的观察范围、作者选择、基线、游标和待提交 Input 仍由 Source 独立管理。一个连接的调用失败不会撤销其它已注册连接。参数和结果使用统一 JSON 事实表示，进程内与 IPC 保持一致。

## Forge 集成

ForgeKind 及现有环境、需求、消息契约位于 `@compforge/aide-connector/builtin`。通用 SDK 根入口独立于这些业务契约；`aide-plugin` 继续转出已有的内置访问类型，并增加通用发现和调用能力。

外部 Forge 实现提供与 ForgeKind 相同的方法，并在 metadata 声明稳定的 forge 身份和 provider 展示名。注册 name 可以是逻辑别名，metadata.forge 用于 Repository/PullRequest 业务身份。现有 Source 的 forge 选择与业务事实使用这一身份。若同一业务身份存在多个连接，通用客户端应使用发现的引用明确选择；便利访问接口在无法唯一选择时拒绝调用。

配置在 Sources 校验之前装配，公开 Forge 目录和 revision 参与现有 RepositorySource/PullRequestSource 的范围校验及检查点隔离。因此内部平台可以在私有包中混合实现仓库枚举、PR 读取等能力，而 Aide 无需包含其域名或专属 API。

## 容量、期限与关闭

同一连接的调用共享活动与等待容量，默认最多四个活动调用、六十四个等待调用，可在实例配置中覆盖。期限包含等待时间，排队调用过期后不再执行。容量只约束方法调用，方法内部分页或并发请求仍受其提供方客户端约束；统一请求速率、突发额度等能力见[长期访问约束](README.md#外部访问约束长期方向)。

Host 向 handler 传入 call.signal，连接关闭或期限到达时取消。实现应遵守信号并设置自身 I/O 超时；无法强制终止不合作的受信任 JavaScript。调用超时与执行失败保留不同的 verb outcome。中断不能证明外部写入未发生，不自动重放调用。

停用配置在重启后生效。注册表卸载先停止发现并取消等待、活动调用，再调用实现的 close；重复关闭共享同一清理过程。启动装配失败也会关闭已创建的连接。Connector 的原始调用参数不进入扩展调用诊断账本，账本记录连接、方法、执行关联和结果。

## 验证

connector-registry 测试覆盖契约冲突、引用绑定、共享容量、排队过期与关闭；connector-packages 测试覆盖本地/npm 包装配、配置与凭证隔离、失败回滚，以及真实 Runner 中的新 Kind 和外部 Forge→Source→Input→Chief 链路。测试使用外部实现替身，不证明具体内部平台 API 的可用性。
