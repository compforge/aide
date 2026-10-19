# Connector 与 Source

Connector 是 Aide Host 提供的全局读取能力，所有 Plugin 和 Chief 都能使用。Host 加载配置、创建连接器并持有提供方客户端；Plugin Runner 通过现有 IPC 查询，不自行读取全局配置。Source 定义个人关注范围和观察策略，Chief 判断变化是否值得通知或推进。

当前支持环境目录、Meego 需求和 GitHub / GitLab PR。环境目录只读取声明；Meego 通过已有 `meegle` CLI 访问，Forge 使用统一 HTTP 客户端。Connector 不创建 Work，也不代替用户决定下一步。

## 配置与所有权

全局文件的选择、字段优先级和默认值规则见 [配置](../configuration.md)。Connector 声明由 Host 在启动时装配，修改后重启。

环境直接声明在 `connectors.environments.<name>`，配置 key 就是环境身份。没有 `provider: static` 或另一个 registry 路径。Meego / Forge 连接信息也放在全局 `connectors`；Personal 的 watches 属于 `plugins.personal`：

```yaml
connectors:
  environments:
    dev:
      kind: kubernetes
      description: 开发联调环境
      aliases: [开发环境]
      kubeconfig: ~/.kube/dev
      context: dev
      namespace: app
    devbox:
      kind: host
      description: Linux 开发机
      host:
        name: devbox
        transport: ssh
        address: devbox
  requirements:
    work:
      provider: meego
      projectKey: your-project-key
      profile: your-meegle-profile
      categories: [story]
      assigneeField: current_status_operator
      userKeys: [your-user-key]
  forges:
    github.com:
      type: github
      # 优先从服务环境的 GITHUB_TOKEN / GH_TOKEN 读取
    gitlab.example.com:
      type: gitlab
      # 优先从服务环境的 GITLAB_TOKEN 读取
plugins:
  personal:
    watches:
      - id: my-requirements
        source: work
        conversationId: me
        intervalMs: 300000
        repositories:
          - forge: github.com
            path: org/repo
```

旧的 `connectors.json` / `AIDE_CONNECTORS` 不再读取。已有配置需把 requirements / forges 移入 connectors，watches 移入 plugins.personal；不保留两份配置的覆盖规则。环境不会从 `~/.agentsphere/env-registry.yaml` 导入。

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
const requirements = await context.connectors.requirements.list("work");
```

目录不绑定 Personal，也不生成 Resource、Task、Source 或持久观察状态。宿主公共接口不返回提供方凭证；这不是插件安全隔离机制，Runner 仍使用服务用户的执行身份。

quality-harness 的 ClientProvider / EnvironmentContext / ClientManager 解决实际访问与生命周期问题，本次只复用环境身份契约。后续需要执行诊断时再按执行范围创建 toolbox 客户端并关闭；全局目录不意味着永久持有所有客户端。TypeScript toolbox 当前的 Kubernetes 访问不能被当作已支持 Python Host worker 的 SSH 能力。

## 观察流程

需求 Source 按负责人和项目范围读取近期摘要，比较实体身份与观察指纹。新观察先持久化为 Input，再推进水位；中断后的重试依靠输入身份去重。已完成或关闭的需求不会创建新的待处理输入。

每个 watch 默认使用 `source:<watch-id>` 作为 sessionId 和 conversationId，也可分别指定。仅配置已有 conversationId 时，sessionId 默认沿用它，适合与同 ID 的飞书 Session 共享上下文；显式指定不同 ID 时，两者的归属保存在该 Session 内。watch 只装配到指定 Session，创建其它聊天不会重复轮询。Host 校验 watch 的负责人范围后，通过 Plugin instance config 下发；重启时以当前配置替换旧 watch 声明。Source 不直接调用模型或创建 Task，Chief 根据已有委托选择询问、CRUD Work 或静默忽略。路由到已有飞书会话的消息才会沿该 Channel 投递，独立 Source 会话可在 Web 查看。

Meego 的“我名下”按指定负责人字段中的稳定 user key 匹配，不按参与人或显示名。默认字段是当前节点处理人；项目若用单独的需求负责人字段，必须配置 `assigneeField`。`userKeys` 对开启的 watch 必填，避免意外观察整个项目。Meegle 单命令超时 20 秒、输出上限 4 MiB。

Forge 的配置 key 是逻辑身份，`api_host` 可以覆盖 API 域名，`uids` 可选过滤 PR 作者。`GITHUB_TOKEN` / `GH_TOKEN`、`GITLAB_TOKEN` 优先于文件 token；没有凭证的 Forge 不启用。服务环境需能找到 `meegle` 并访问其登录态，不能只在交互 shell 中配置 PATH。

飞书目标为 `feishu:<app-id>:<chat-id>`，可从入站日志的 conversationId 获取。机器人需要已经收到过该单聊的消息，才会向其投递。模型沿用 Pi 的 `~/.pi/agent` 配置；`AIDE_MODEL` 只控制开发用 Codex。

当前 Meego 每个类别读取最近更新的 50 条，再筛选负责人；不保证覆盖高流量项目的全量变更。首次连接会把这批范围内尚未结束的条目交给 Chief；配置范围改变也会建立新的观察范围。后续仅在指纹变化时再次提交。尚未接 webhook、全量分页或 Forge 定时 Source；Forge 当前供 Chief 查询 PR 状态与评论。

框架的调度见 [Plugin](../plugin/README.md)；决策策略见 [Personal](../plugin/personal.md)。

## 验证

配置测试覆盖名称与别名冲突、结构错误、缺失文件和启动快照；真实 Runner 测试验证多个插件共享 Connector、跨 IPC 查询和错误传播。真实 Pi SDK 配合模拟模型服务验证 Chief 环境工具，并回归 Source → Chief → 用户决定 → Work 链路。

需求测试覆盖负责人筛选、观察水位与去重；Forge 测试覆盖协议映射、评论、限流与错误行为。测试未连接真实环境、账号或模型，不能证明网络可达、部署健康或提示词效果。
