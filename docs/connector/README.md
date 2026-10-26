# Connector 与 Source

Connector 是 Host 提供的外部访问能力；Source 是 Personal 的持续观察策略。connectors 声明访问方式与账号，plugins.personal.sources 选择关注范围和频率。只声明 Connector 可供按需读取，不启动观察。

Host 装配统一客户端并持有凭证，Runner 经类型化 API 查询。平台评论写入由 Host 消费 Output；来源观察不直接通知用户或创建 Work。访问账号与可选 Me 标记分别表达权限与被服务的人，见 [Person](../personal/person.md)。

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

配置 key 是逻辑身份，api_host 可覆盖 API 域名，uids 可过滤 PR 作者。GITHUB_TOKEN / GH_TOKEN、GITLAB_TOKEN 优先于文件 token；没有凭证的 Forge 不启用。统一 HTTP 客户端处理协议、超时与错误，Source 策略不进入 Connector 的默认查询。

## 验证

自动测试覆盖配置校验、多个插件共享 Connector、跨 IPC 查询、分页与错误传播。各接入文档列出覆盖边界。真实验收还需确认服务用户的 CLI / PATH、登录态、平台权限与实际结果；HTTP 健康检查不证明外部依赖可用。
