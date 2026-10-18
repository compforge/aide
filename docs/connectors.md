# Connector 与 Source

Connector 提供访问外部系统和映射数据的能力。Source 定义关注范围，持续观察变化；Chief 再判断变化是否值得通知或推进。用户可以先配置自己名下的 Meego 需求，让 Aide 发现变化后询问下一步。

当前 Meego Connector 调用已有 `meegle` CLI，Forge Connector 通过统一 HTTP 客户端访问 GitHub / GitLab。Connector 不创建 Work，也不代替用户决定下一步。Chief 可以直接用这些连接器读取需求、PR 和评论。

## 观察流程

需求 Source 按负责人和项目范围读取近期摘要，比较实体身份与观察指纹。新观察先持久化为 Input，再推进水位；中断后的重试依靠输入身份去重。已完成或关闭的需求不会创建新的待处理输入。

每个 watch 默认使用 `source:<watch-id>` 会话，也可配置已有 conversationId。Source 不直接调用模型或创建 Task，Chief 根据已有委托选择询问、CRUD Work 或静默忽略。路由到已有飞书会话的消息才会沿该 Channel 投递，独立 Source 会话可在 Web 查看。

框架的 Source / Controller 如何调度这项业务见 [Plugin](plugin.md)；决策策略见 [Personal](personal.md)。

## 配置

默认读取 `$AIDE_HOME/connectors.json`（未设 AIDE_HOME 时为 `~/.aide/connectors.json`），也可用 `AIDE_CONNECTORS` 指定文件。无配置时仍可聊天、操作 Work 和使用已有 CLI。示例中的标识需要换成自己的真实值：

```json
{
  "requirements": {
    "work": {
      "provider": "meego",
      "projectKey": "your-project-key",
      "profile": "your-meegle-profile",
      "categories": ["story"],
      "assigneeField": "current_status_operator",
      "userKeys": ["your-user-key"]
    }
  },
  "forges": {
    "github.com": { "type": "github", "token": "your-token" },
    "gitlab.example.com": { "type": "gitlab", "token": "your-token" }
  },
  "watches": [{
    "id": "my-requirements",
    "source": "work",
    "conversationId": "me",
    "intervalMs": 300000,
    "repositories": [{ "forge": "github.com", "path": "org/repo" }]
  }]
}
```

Meego 的“我名下”按指定负责人字段中的稳定 user key 匹配，不按参与人或显示名。默认字段是当前节点处理人；项目若用单独的需求负责人字段，必须配置 `assigneeField`。`userKeys` 对开启的 watch 必填，避免意外观察整个项目。Meegle 单命令超时 20 秒、输出上限 4 MiB。

Forge 的配置 key 是逻辑身份，`api_host` 可以覆盖 API 域名，`uids` 可选过滤 PR 作者。`GITHUB_TOKEN` / `GH_TOKEN`、`GITLAB_TOKEN` 优先于文件 token；没有凭证的 Forge 不启用。服务环境需能找到 `meegle` 并访问其登录态，不能只在交互 shell 中配置 PATH。

飞书目标为 `feishu:<app-id>:<chat-id>`，可从入站日志的 conversationId 获取。机器人需要已经收到过该单聊的消息，才会向其投递。模型沿用 Pi 的 `~/.pi/agent` 配置；`AIDE_MODEL` 只控制开发用 Codex。修改连接器配置后重启 Aide。

当前 Meego 每个类别读取最近更新的 50 条，再筛选负责人；不保证覆盖高流量项目的全量变更。首次连接会把这批范围内尚未结束的条目交给 Chief；配置范围改变也会建立新的观察范围。后续仅在指纹变化时再次提交。尚未接 webhook、全量分页或 Forge 定时 Source；Forge 当前供 Chief 查询 PR 状态与评论。

## 验证

需求测试覆盖负责人筛选、观察水位与去重；Forge 测试覆盖协议映射、评论、限流与错误行为。真实账号权限、CLI 登录和网络需要部署后验证，不能用替身测试代替。
