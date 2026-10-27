# Connector 与 Source

Connector 提供外部资源的操作与适配；业务 Source 根据这些能力组织持续观察。connectors 声明访问方式与账号，plugins.personal.sources 选择关注范围和频率。只声明 Connector 可供按需读取，不启动观察。

Host 装配统一客户端并持有凭证，Runner 经类型化 API 查询。平台评论写入由 Host 消费 Output；来源观察不直接通知用户或创建 Work。访问账号与可选 Me 标记分别表达权限与被服务的人，见 [Person](../personal/person.md)。

## 职责与粒度

Connector 通常按外部系统或服务划分，一个外部接入对应一个 Connector，通过连接配置区分实例与账号。它统一承接认证、协议和数据适配、外部操作与访问约束。同一外部系统内的 Repository、PullRequest 等业务对象，由同一个 Connector 暴露相应能力。

一个 Connector 可以支持多个业务 Source。Source 按业务目标和观察生命周期划分，分别拥有观察范围、刷新频率、快照、检查点和下游交接策略。需要独立调度、重试或回收时，Source 的粒度可以细到一个业务 Resource；集合观察与单对象观察都由实际业务决定，不要求 Source 与 Connector 一一对应。

Forge 的演进方向是一个 Forge Connector 支持 RepositorySource 与 PullRequestSource：前者维护低频刷新的仓库清单，后者观察 PR 变化。两者共享外部访问能力，各自拥有业务状态；Source 可以维护其它观察资源，也可以将变化形成 Input。当前实现仍使用 ForgeSource，拆分属于后续更新，不代表这些新资源已经可配置。

## 外部访问约束（长期方向）

外部资源具有请求配额和承载能力，Connector 的长期契约应包含可配置的请求速率、突发额度与并发上限，并配合超时、有界等待和重试策略。Source 的观察频率表达业务时效要求；实际外部请求还必须遵守接入侧的统一访问预算。

限速应按外部服务真实的配额范围组织，例如服务实例、账号或接口。共享配额的多个 Source、插件和按需调用应共享预算，新增 Source 或并发资源不能各自获得一份独立额度。分页请求、内部重试同样计入实际请求预算；底层统一客户端已有的控制能力应直接复用，避免在多个层次重复排队与重试。

遇到服务端限流时，应遵守其重试时间提示并进行有界退避，将等待、限流与失败反馈给调用方。Source 据此保留检查点并重新调度。诊断应能区分业务轮询间隔、预算等待和外部请求失败，且不记录凭证。

当前各接入已有的超时和限流错误处理以实现及对应文档为准；这里定义的是待建设的统一配置与共享预算能力，不表示当前已具备 Connector 级统一限速器。

## 接入目录

| 接入 | 访问与观察 |
| --- | --- |
| [环境](environments.md) | 环境声明、Kubernetes Workload 采样、变化基线 |
| [Lark 消息](lark-messages.md) | 用户身份读取、单聊与群内 @、可选上下文与短期跟进 |
| [需求平台](requirements.md) | 需求及评论观察、人物识别、评论投递与回读 |
| [Forge](forge.md) | GitHub / GitLab PR 按需查询、按账号跨仓库观察状态与 revision 变化 |

Lark 用户消息观察与 [机器人 Channel](../channel/lark.md) 使用不同身份和入口，分别配置。总体字段优先级见 [配置](../configuration.md)。

## 观察与恢复

Source 先持久化观察计划和 Input，再推进水位。输入身份应在重试中保持稳定，避免一次外部变化被重复处理。读取失败保留检查点，不把访问失败解释成对象消失或目标完成。

每种提供方说明自己的扫描窗口、分页、首次观察和覆盖限制。观察是事实来源，路由统一交给 [Route](../personal/route.md)；是否值得行动或沟通由已有委托与 Chief 判断。

## Forge 配置

```yaml
connectors:
  forges:
    github.com:
      type: github
    gitlab.example.com:
      type: gitlab
```

配置 key 是逻辑身份，api_host 可覆盖 API 域名。GITHUB_TOKEN / GH_TOKEN、GITLAB_TOKEN 优先于文件 token；没有凭证的 Forge 不启用。统一 HTTP 客户端处理协议、超时与错误，Source 策略不进入 Connector 的默认查询。

PR 作者范围由 `plugins.personal.sources.forges[].author` 显式指定，凭证不决定作者。旧 Connector `uids` 字段在加载时忽略，不参与查询；配置示例与观察契约见 [Forge](forge.md)。

## 验证

自动测试覆盖配置校验、多个插件共享 Connector、跨 IPC 查询、分页与错误传播。各接入文档列出覆盖边界。真实验收还需确认服务用户的 CLI / PATH、登录态、平台权限与实际结果；HTTP 健康检查不证明外部依赖可用。
