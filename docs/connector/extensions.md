# 外部 Connector 扩展

Connector kind 是用于发现Connector的字符串，领域 interface 定义操作，外部包提供实现，Host 将配置装配为Connector。调用方按 Kind 发现Connector，使用类型化客户端；新增 Kind 不修改 Host/Runner 的 operation 列表。Connector 当前由配置和注册表管理，是否持久化为 Resource 独立演进。

## 边界

`packages/connector` 提供引用、描述、包定义与客户端契约，各领域入口导出 kind 字符串及操作类型；`src/host/connector` 实现加载、注册、调用与关闭。内置 Connector 与外部包使用同一个注册表，Plugin 回调、Reconcile 与 verb 共享相同Connector。Source 继续在 Plugin 中声明业务资源、观察和 Input 交接，不单独发布 Source SDK。

包入口只在 Host 加载，拥有私有配置及环境访问。Runner 获得不含凭证的描述和方法结果。外部模块是显式安装的受信任代码；进程职责边界不构成运行不可信代码的安全沙箱。

## 声明与注册

配置直接按 name 声明 Connector；kind 与 version 表示操作契约，不选择实现。没有 packages、instances、connections 或 type 字段：

```yaml
connectors:
  github:
    kind: forge
    version: v1
    config:
      provider: github
      host: github.com
      tokenEnv: GITHUB_TOKEN
    maxConcurrentCalls: 4
    maxQueuedCalls: 64
  codebase:
    kind: forge
    version: v1
    config:
      tokenEnv: COMPANY_TOKEN
```

name 是稳定名称，不等同于 host。同一 kind 或同一 host 可以声明多个名字，每个 Connector 分别持有访问配置、调用容量和生命周期。enabled 默认为 true。version 按字符串精确匹配，不做隐式升级。

Host 在安装阶段通过 `AIDE_CONNECTOR_REGISTRATION=./connectors.ts` 指定注册入口。入口默认导出 ConnectorPackage，把配置中的 name 绑定到导入的工厂：

```ts
import type { ConnectorPackage } from "@compforge/aide-connector";
import { codebase } from "@company/aide-connectors";

export default {
  id: "my-connectors",
  version: "1.0.0",
  connectors: { codebase },
} satisfies ConnectorPackage;
```

注册入口可以导入多个已安装的包，也可把同一个工厂绑定到多个 name。入口路径相对于 Aide 配置文件目录解析；也支持从该目录解析已安装的 npm 模块。Host 不接受网络模块 URL，也不自动下载安装。实现选择只发生在注册阶段：同名注册优先，未显式注册的名字使用 Host 内置的 kind/version 默认工厂。显式注册的 kind/version 不匹配时启动失败，不能退回默认工厂。

内置 forge/v1 工厂使用 repocli；其私有 config.provider 选择 repocli 支持的 github 或 gitlab 协议，config.host 指定地址，config.forge 可覆盖业务身份。provider 不是 Host 实现注册标识，外部工厂可使用完全不同的配置 schema。上例 github 使用内置工厂，codebase 使用独立安装的私有工厂；Aide 不包含公司域名或专属 API。

内置 environment/v1 工厂的 config 是环境目录；requirement/v1 使用 Meego 配置；messages/v1 使用 Lark app/user 配置。它们都经过同一装配、容量和关闭流程。现有 Personal 环境/消息便利接口各使用一个目录/账号；多 Connector 的通用调用通过发现的引用明确选择。

config 由所选工厂校验，凭证建议通过 tokenEnv 等配置引用，在 create(context, config) 中调用 context.env() 解析。环境依赖在创建阶段固定，其值与注册入口版本、契约和私有配置共同生成访问 revision，描述不返回原值。更换实现时更新注册入口版本。非法定义在工厂运行前拒绝；配置、创建或注册失败时，已创建 Connector 逆序关闭，错误仅报告 name、契约和注册来源。

## 发现与使用

kind 与 version 是独立的非空字符串，例如 `kind: "forge"`、`version: "v1"`。version 标识操作契约版本，与 `ConnectorPackage.version` 的包发布版本分开。操作由 TypeScript interface 表达，提供方使用 `ConnectorDefinition<Config, Operations>` 约束实现；Host 从 handlers 提取可调用方法，领域参数和结果校验由实现负责。

Plugin 使用 `context.connectors.list("forge")` 获取该 kind 的所有Connector，或用 `list("forge", "v1")` 按版本精确筛选，再用 `get<ForgeOperations>(description)` 取得类型化客户端。Reconcile 通过 `execution.verbs.connectors({timeoutMs})` 使用同一 API，调用仍进入现有 verb 诊断和恢复机制。版本按字符串精确匹配，不做隐式升级或兼容性推断。

发现得到的Connector包含 name、kind、version、revision、方法列表和显式公开的 metadata。引用绑定操作版本与具体访问 revision；Connector替换后旧引用报错，调用方重新发现，不自动切换账号。注册描述只说明Connector已装配，远端权限与可用性由实际调用确认。

Source 可以遍历同 Kind 的所有Connector；各Connector的观察范围、作者选择、基线、游标和待提交 Input 仍由 Source 独立管理。一个Connector的调用失败不会撤销其它已注册Connector。参数和结果使用统一 JSON 事实表示，进程内与 IPC 保持一致。

## Forge 集成

字符串常量 ForgeKind、ForgeVersion 与相关类型由 `@compforge/aide-connector/forge` 导出；环境、需求、消息契约分别由 `/environment`、`/requirement`、`/message` 导出。每个入口同时提供 Kind 和对应类型，内置与外部提供方共享同一契约；具体实现位于顶层 `connectors/` 或外部包。通用 SDK 根入口独立于这些领域契约；`aide-plugin` 提供 Plugin 使用的聚合 ConnectorClient，并转出领域类型。

外部 Forge 实现声明 `kind: "forge"`、`version: "v1"` 并实现 `ForgeOperations`，并在 metadata 声明稳定的 forge 身份和 provider 展示名。注册 name 可以是逻辑别名，metadata.forge 用于 Repository/PullRequest 业务身份。现有 Source 的 forge 选择与业务事实使用这一身份。若同一业务身份存在多个Connector，通用客户端应使用发现的引用明确选择；便利访问接口在无法唯一选择时拒绝调用。

配置在 Sources 校验之前装配，公开 Forge 目录和 revision 参与现有 RepositorySource/PullRequestSource 的范围校验及检查点隔离。因此内部平台可以在私有包中混合实现仓库枚举、PR 读取等能力，而 Aide 无需包含其域名或专属 API。

## 容量、期限与关闭

同一Connector的调用共享活动与等待容量，默认最多四个活动调用、六十四个等待调用，可在Connector 配置中覆盖。期限包含等待时间，排队调用过期后不再执行。容量只约束方法调用，方法内部分页或并发请求仍受其提供方客户端约束；统一请求速率、突发额度等能力见[长期访问约束](README.md#外部访问约束长期方向)。

Host 向 handler 传入 call.signal，Connector关闭或期限到达时取消。实现应遵守信号并设置自身 I/O 超时；无法强制终止不合作的受信任 JavaScript。调用超时与执行失败保留不同的 verb outcome。中断不能证明外部写入未发生，不自动重放调用。

停用配置在重启后生效。注册表卸载先停止发现并取消等待、活动调用，再调用实现的 close；重复关闭共享同一清理过程。启动装配失败也会关闭已创建的Connector。Connector 的原始调用参数不进入扩展调用诊断账本，账本记录Connector、方法、执行关联和结果。

## 验证

connector-registry 测试覆盖字符串 kind 发现、方法表校验、引用绑定、共享容量、排队过期与关闭；connector-packages 测试覆盖本地/npm 包装配、非法 kind/handlers 诊断、配置与凭证隔离、失败清理及回滚，以及真实 Runner 中的新 Kind 和外部 Forge→Source→Input→Chief 链路。测试使用外部实现替身，不证明具体内部平台 API 的可用性。
