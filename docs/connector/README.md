# Connector 与 Source

Connector 提供外部资源的操作与适配；业务 Source 根据这些能力组织持续观察。connectors 声明访问方式与账号，plugins.personal.sources 选择关注范围和频率。只声明 Connector 可供按需读取，不启动观察。

Host 装配统一客户端并持有凭证，Runner 经类型化 API 查询。平台评论写入由 Host 消费 Output；来源观察不直接通知用户或创建 Work。访问账号与可选 Me 标记分别表达权限与被服务的人，见 [Person](../personal/person.md)。

## 职责与粒度

Connector 通常按外部系统或服务划分，一个外部接入对应一个 Connector，通过连接配置区分实例与账号。它统一承接认证、协议和数据适配、外部操作与访问约束。同一外部系统内的 Repository、PullRequest 等业务对象，由同一个 Connector 暴露相应能力。

一个 Connector 可以支持多个业务 Source。Source 按业务目标和观察生命周期划分，分别拥有观察范围、刷新频率、快照、检查点和下游交接策略。需要独立调度、重试或回收时，Source 的粒度可以细到一个业务 Resource；集合观察与单对象观察都由实际业务决定，不要求 Source 与 Connector 一一对应。

Forge 由一个 Forge Connector 支持 RepositorySource 与 PullRequestSource：前者维护低频刷新的仓库清单，后者观察 PR 变化。两者共享外部访问能力，各自拥有业务状态；Source 可以维护其它观察资源，也可以将变化形成 Input。配置、快照与恢复契约见 [Forge](forge.md)。

## 外部访问约束

外部限流的策略、数值与配额范围由对应 Connector / Channel 适配：可能按账号、接口或聊天限制，不能由 Output 统一设定。需要主动节流时，在接入侧复用共享客户端及其配置；共享同一外部配额的实际调用应遵守同一策略，包括分页与内部重试。Host 的有界调用容量负责运行保护，不代表提供方 QPS。

Source 的观察频率表达业务时效要求，读取失败保留检查点并重新调度。出站投递由适配器将平台拒绝、永久失败和未知结果转换为[安全错误契约](extensions.md#host-投递错误)，可携带平台建议的等待时间；Output Reconciler 保存原因并使用已有队列重试。适配器不枚举 Output，不重启 Chief，也不自建业务重试队列。

没有等待时间提示时使用现有控制器退避。不同接入的频控参数留在各自配置，不建设跨所有提供方的统一外部调用预算。人物沟通频率是独立的产品策略，见 [Output 投递频控](../personal/output.md#投递频控)。

外部实现的包入口、Kind 注册、发现与调用见 [Connector 扩展](extensions.md)。Source 继续复用 Plugin 的运行机制。

## 接入目录

| 接入 | 访问与观察 |
| --- | --- |
| [环境](environments.md) | 环境声明、Kubernetes Workload 采样、变化基线 |
| [Lark 消息](lark-messages.md) | 用户身份读取、单聊与群内 @、可选上下文与短期跟进 |
| [需求平台](requirements.md) | 需求及评论观察、人物识别、评论投递与回读 |
| [Forge](forge.md) | GitHub / GitLab 仓库清单缓存、按仓库或账号观察 PR 合并 |

Lark 用户消息观察与 [机器人 Channel](../channel/lark.md) 使用不同身份和入口，分别配置。总体字段优先级见 [配置](../configuration.md)。

## 观察与恢复

Source 先持久化观察计划和 Input，再推进水位。输入身份应在重试中保持稳定，避免一次外部变化被重复处理。读取失败保留检查点，不把访问失败解释成对象消失或目标完成。

每种提供方说明自己的扫描窗口、分页、首次观察和覆盖限制。观察是事实来源，路由统一交给 [Route](../personal/route.md)；是否值得行动或沟通由已有委托与 Chief 判断。

## Forge 配置

```yaml
connectors:
  github.com:
    kind: forge
    version: v1
    config:
      provider: github
      host: github.com
  gitlab.example.com:
    kind: forge
    version: v1
    config:
      provider: gitlab
      host: gitlab.example.com
```

配置 key 是 Connector name，config.host 是访问地址，config.forge 可覆盖业务身份。GITHUB_TOKEN / GH_TOKEN、GITLAB_TOKEN 优先于 config.token；启用但缺失凭证的 Forge 在创建时明确报错。统一 HTTP 客户端处理协议、超时与错误，Source 策略不进入 Connector 的默认查询。

PR 作者范围由 `plugins.personal.sources.pullRequests[].author` 显式指定，凭证不决定作者。配置示例与观察契约见 [Forge](forge.md)。

## 验证

自动测试覆盖配置校验、多个插件共享 Connector、跨 IPC 查询、分页与错误传播。各接入文档列出覆盖边界。真实验收还需确认服务用户的 CLI / PATH、登录态、平台权限与实际结果；HTTP 健康检查不证明外部依赖可用。
