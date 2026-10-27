# Forge PR/MR 合并输入

Forge Connector 提供 GitHub / GitLab 的只读访问，ForgeSource 按显式账号跨仓观察 PR/MR。
当前自动输入聚焦已经合并的事实：Source 保存 Input，Route 按 PR 身份定位 Topic，Chief 决定更新认识、
关联已有委托或沟通。Source 不直接创建 Work 或 Output。

## 职责与公共契约

Repository / PullRequest 身份和基础事实来自 `@compforge/harness-common`。`@compforge/repocli` 提供
平台请求、分页、扫描覆盖、不透明检查点和 HTTP 约束。Host 持有客户端及凭证，Runner 通过 Connector IPC
请求能力；Personal ForgeSource 拥有观察策略、业务基线、持久接纳与调度。

| Connector 操作 | 结果 |
|---|---|
| `scanPullRequests(forge, query)` | 有界批次：common snapshots、cursor、pending、complete、issues |
| `listPullRequests(forge, query)` | 单页 common keys，nextCursor 与可选 issues；显式 account/repository scope |
| `getPullRequest(key)` | common `PullRequestSnapshot`，不请求评审 |
| `getPullRequestReview(key)` | 独立的评审状态、活动指纹和可用的合并条件 |
| `listPullRequestComments(key)` | 评论及嵌套回复 |

类型复用 common / repocli，Aide 不定义第二套平台模型，不传递依赖 id() 方法的对象。
Chief 的 list_pull_requests 使用 pageSize / cursor，返回单页而不是静默截断的数组；
read_pull_request_review 按需查询评审。评审失败不会撤回先前得到的生命周期事实。
单页 continuation 当前封装平台页号，不是稳定的 last_id/keyset；扫描 cursor 则是独立的恢复检查点。
Aide 不解析任何 cursor 内部字段。

## 配置

```yaml
connectors:
  forges:
    github.com:
      type: github
    gitlab.example.com:
      type: gitlab
plugins:
  personal:
    sources:
      forges:
        - id: github-mine
          forge: github.com
          author: your-github-login
          intervalMs: 300000
          initialLookbackMs: 604800000
        - id: gitlab-mine
          forge: gitlab.example.com
          author: your-gitlab-username
```

GitHub 使用 GITHUB_TOKEN / GH_TOKEN，GitLab 使用 GITLAB_TOKEN；也可在 Connector 配置 token。
凭证不决定作者，author 必须是显式平台 username。旧 Connector uids 不再参与查询，加载已有共享配置时忽略它。
Source id 与 forge/author 组合分别唯一；引用未知 Forge 时启动拒绝。省略或清空 forges 不启动观察，
删除配置并重启后遗留 Source 不再执行。配置启动时解析，修改后重启生效。
本轮继续账号扫描，不引入仓库清单缓存或仓库枚举回退；不可用的账号端点保留覆盖错误。

## 观察与 Input 接纳

Source 调用 `scanPullRequests({scope: {kind: "account", author}, initialSince, cursor, tracked})`，
tracked 包含已有 open 对象及升级时保留的待补查 keys。平台时间窗、分页、重叠和失败对象重试全部属于 repocli。
初始历史回看由 initialLookbackMs 决定；repocli 另枚举 open 清单。

Source status 分开保存：

- tracked：common snapshot 与基础事实指纹，代表已消费基线；open 持续跟踪，terminal 基线保留一个回看周期。
- cursor / scanPending / scanComplete / issues：repocli 扫描进度及覆盖状态。
- batch：冻结的结果、逐项 offset 与本批 inputSince，尚未整体提交扫描检查点。
- pending / sequence：已冻结 Input 计划与发生序号，保证写入中断后恢复同一个 Input。

open、closed、revision、标题和合并条件变化只更新基线。已有对象从非 merged 变为 merged 时生成
`observation.kind=forge.merged` 的 Input；首次发现 merged，只有明确的 mergedAt 落在接纳回看范围内才补录。
缺失合并时间的未知历史对象只建立基线，之后已跟踪 open→merged 不要求平台提供 mergedAt。
inputSince 随保留期限单调前进，避免已过期基线对应的旧合并在历史重扫时再次补录。
冻结 batch 保存自己的 inputSince，恢复时使用冻结值，不因长时间中断而过滤未消费结果。

评审不自动轮询、不进入基础事实指纹。conflictState、mergeReadiness、state=merged 互不替代。
Input 保存当前快照、已有的前一快照和 authorScope；Topic key 沿用 forge + 目标仓 path + number。
同号不同仓库保持独立，fork 或追加提交不改变 Topic 身份。relation=observed 不表示 Me 发言或授予修改权限。

每次合并先冻结 Input 计划，再持久写 Input，最后推进基线与 batch offset；全部 items 消费后才提交 cursor。
pending Input 在完成前受资源引用保护。重启先恢复冻结计划和 batch，不重新读取覆盖未消费事实。
已写 Input 的重放使用同一 name；继续观察同一个 merged 的元数据变化不会再生成合并 Input。

## 覆盖、调度与恢复

部分失败的批次仍消费成功 items，原样保存结构化 issues。列表缺席、404、鉴权失败或覆盖缺口均不表示合并。
scanPending 与 scanComplete 独立：pending=true 表示还有工作，complete=false 表示有工作或尚存覆盖缺口。
404 不阻止下一批健康对象；pending=false 即使不完整也回到正常轮询。认证、传输、容量错误按正常间隔退避，
rate_limit 额外尊重 retryAfterMs。Input 持久化等整次执行异常使用 status.error，不能把部分覆盖错误伪装成无变化。
Source 日志记录 watchId、Forge、PR key、Input id、pending/complete 和 issue stage/kind/window。
不同 Source 独立调度，一个 Forge 的失败不阻止另一个 Forge 输入。

repocli 的每请求超时和响应上限沿用库默认值。扫描的重试、发现与 tracked 阶段各有 20 秒预算，
Source 的 Connector 调用期限为 90 秒，给三个阶段及 IPC 留出余量。
轮询只提供当时可见的快照，不是完整事件日志；删除、失权、搜索索引延迟或不可用端点造成的缺口仍需处理。

## 从旧版本升级

Aide Source schemaVersion=2 与 repocli cursor 版本是不同契约。升级一次性执行：

1. 将 identity/lifecycle/mergeability 基线转换为 common 字段，移除历史评审附加字段，重新计算基础指纹。
2. 保留 Source UID、Topic key、sequence 和 pending Input 的 name、正文、observation；只转换 pending 内部基线。
3. 保留旧 batch 的 items 和消费 offset，先消费完冻结事实；旧 batch 提议的 cursor 不再提交。
4. 废弃 v1 cursor，以保留的初始回看起点和 seed/open keys 启动新扫描；不读取私有 cursor 字段。
5. 业务基线与 inputSince 防止旧历史被当作新变化。消费方部署必须与插件公共契约一同升级。

repocli 新 cursor 还绑定连接凭据；更换 token 后旧 cursor 会被拒绝。需要重置扫描进度时保留业务基线、
pending、batch 和 sequence，不能通过清空整个 Source 来解决游标不兼容。

## 验证

`tests/forge-source.test.ts` 覆盖合并接纳、部分失败、冻结 Input/batch、旧状态升级、历史去重、限流调度，
以及真实 Runner IPC→Input→Route→Chief 的处理回执和跨 Forge 故障隔离。
`tests/forge.test.ts` 覆盖两平台客户端装配、公共事实序列化及独立评审访问；平台分页、映射与 HTTP 细节由 repocli 验证。
上述测试使用平台替身；真实账号可见范围和部署效果需另行验收。
