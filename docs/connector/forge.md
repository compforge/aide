# Forge 仓库与 PR/MR 观察

一个 Forge Connector 提供外部操作，RepositorySource 与 PullRequestSource 分别拥有仓库发现和 PR 观察策略。
RepositorySource 维护低频刷新的仓库清单，并为配置的作者创建每仓库独立的 PullRequestSource。
PullRequestSource 保存 PR 基线，将 merged 变化形成 Input，交给 Route 与 Chief 处理。
Source 不直接创建 Work 或 Output。

## 职责与公共契约

Repository / PullRequest 身份和基础事实来自 `@compforge/harness-common`。`@compforge/repocli` 提供
平台请求、分页、扫描覆盖、不透明检查点和 HTTP 约束。Host 持有客户端及凭证，Runner 通过 Connector IPC
请求能力；Personal 拥有缓存、观察策略、业务基线、持久接纳与调度。

| Connector 操作 | 结果 |
|---|---|
| `listRepositories(forge, query)` | 单页 common RepositorySnapshot，nextCursor 与可选 issues |
| `scanPullRequests(forge, query)` | 有界批次：common snapshots、cursor、pending、complete、issues |
| `listPullRequests(forge, query)` | 单页 common keys，nextCursor 与可选 issues；显式 account/repository scope |
| `getPullRequest(key)` | common PullRequestSnapshot，不请求评审 |
| `getPullRequestReview(key)` | 独立的评审状态、活动指纹和可用的合并条件 |
| `listPullRequestComments(key)` | 评论及嵌套回复 |

类型复用 common / repocli，Aide 不定义第二套平台模型，不传递依赖 id() 方法的对象。
Chief 的 list_pull_requests 使用 pageSize / cursor；read_pull_request_review 按需查询评审。
评审失败不会撤回先前得到的生命周期事实。Aide 不解析 cursor 内部字段；
单页 continuation 当前封装平台页号，扫描 cursor 则是独立的恢复检查点。

## 配置与观察范围

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
plugins:
  personal:
    sources:
      repositories:
        - id: company-repositories
          forge: gitlab.example.com
          refreshIntervalMs: 21600000
          retryIntervalMs: 60000
      pullRequests:
        - id: company-pullrequests
          repositories: company-repositories
          author: your-company-username
          intervalMs: 300000
          initialLookbackMs: 604800000
        - id: github-mine
          forge: github.com
          author: your-github-login
```

GitHub 使用 GITHUB_TOKEN / GH_TOKEN，GitLab 使用 GITLAB_TOKEN；也可在 Connector 配置 token。
凭证决定可访问范围，author 显式决定 PR 作者。
PullRequest 策略选择 repositories 引用或 forge 账号范围之一；每种 Source 的 id 唯一，
一个 Forge 配置一个 RepositorySource，同一 Forge/author 只使用一条 PR 发现策略，避免重叠观察。
未知 Connector、未知 RepositorySource 引用及重复范围在启动时拒绝。

repositories 策略展开为每个 RepositoryKey + author 一个 PullRequestSource；forge 策略直接创建账号级
PullRequestSource。两者使用同一观察实现，分别传递 repocli 的 repository/account scope。
GitHub 的账号级发现可覆盖向外部仓库提交的 PR。仓库枚举范围由 Connector 凭证和平台接口决定：
当前 GitLab 使用 membership 项目，GitHub 使用 /user/repos；它们不保证覆盖该作者创建过 PR 的所有仓库。
不会因账号端点报错而静默切换发现范围，需显式选择配置。

省略或清空相应列表关闭观察，Connector 仍可按需读取。配置启动时解析，修改后重启生效。刷新频率、轮询间隔和回看时长的调整保留资源 UID 与检查点。
旧 sources.forges 配置和 ForgeSource 资源不做兼容或迁移，新部署按上述配置建立观察状态。
Host 从实际连接配置生成不携带原始凭证的 connectionRevision；连接端点、提供方或凭据变化会形成新观察实例，
旧实例停止外部读取并排空已冻结事实。新实例按首次观察规则建立自己的清单和基线。

## RepositorySource：缓存与交接

每个 RepositorySource 对应一个 Forge 访问范围，默认六小时刷新、失败后一分钟重试。
status.snapshot 使用 `SourceSnapshot<T> = { value, observedAt }` 保存上次完成的仓库清单；
refresh 保存本轮候选 items、cursor 和起始时间，handoff 保存完整清单向 PR 观察任务交接的进度。

一次协调最多读取一页，成功后先持久化候选清单和下一页 cursor。重启从已保存分页进度继续；
过期清单在刷新期间仍供已有观察任务使用。只有所有分页完成且没有 issues 才替换 snapshot。
分页中断保留旧快照和刷新进度；带覆盖缺口的结果不发布，保留旧快照并退避后重新枚举。
冷启动必须完成第一份清单才创建 PR 观察任务。这里的完整表示分页成功遍历，并不承诺远端列表的原子时点一致性。

发布清单时同时冻结 handoff；每次协调最多交接二十个观察任务。按确定身份幂等创建子资源，
创建成功后才推进 offset。创建后进程中断可安全重试；handoff 未完成期间不发起新一轮外部刷新。
缓存仍有效时，重启也会对账新配置的 PR 策略，复用同一清单创建缺失的观察任务。

新清单通过 Watch 唤醒关联的 PullRequestSource。仓库只有在完整清单中缺席才退出观察；
刷新失败、分页未完成或缓存到期都不会撤销原有成员。退出观察不表示 PR 已关闭或合并。
移除配置、改变访问范围或删除父资源后，子观察任务停止外部请求，排空冻结 Input/batch 后标记 retiredAt，
允许资源保留策略回收。重新启用且旧实例仍保留时可复用其状态。

## PullRequestSource：快照与 Input

status.snapshot 同样采用 SourceSnapshot，value 保存按 PR 身份索引的已处理快照、fingerprint 和终态保留时间。
SourceSnapshot 只表达已提交事实及其时间；缓存刷新、扫描和下游交付进度由各 Source 的独立状态承载。
不以缓存 TTL 推进 PR 基线，也不将所有 Source 强制套入同一读取或差异计算流程。

PullRequestSource 调用 scanPullRequests，tracked 仅传递已有 open 对象。
平台时间窗、分页、重叠和失败对象重试由 repocli 承担。initialLookbackMs 决定初始历史回看，
repocli 另枚举 open 清单。Source 保存：

- snapshot：已处理的 common PR 快照与指纹；open 持续跟踪，终态基线保留一个回看周期。
- cursor / scanPending / scanComplete / issues：repocli 扫描进度及覆盖状态。
- batch：冻结的扫描结果、逐项 offset 与本批 inputSince。
- pending / sequence：冻结的 Input 计划与发生序号。

open、closed、revision、标题和合并条件变化只更新基线。已有对象从非 merged 变为 merged 时生成
observation.kind=forge.merged 的 Input；首次发现 merged，只有明确的 mergedAt 落在接纳回看范围内才补录。
缺失合并时间的未知历史对象只建立基线，之后已跟踪 open→merged 不要求平台提供 mergedAt。
inputSince 随保留期限单调前进，避免过期基线对应的历史合并在重扫时再次补录；
冻结 batch 使用自己的 inputSince，长时间中断不会过滤已冻结但未消费的事实。

每次合并先冻结 Input 计划，再持久写 Input，最后推进 snapshot 基线与 batch offset；全部 items 消费后才提交 cursor。
pending Input 在完成前受资源引用保护。重启先恢复冻结计划和 batch，重放使用同一 Input name。
评审不自动轮询、不进入基础事实指纹；同一个 merged 的后续元数据变化不再形成合并 Input。
Topic key 使用 forge + 目标仓 path + number；relation=observed 不表示 Me 发言或授权修改代码。

## 覆盖与调度

不同 PullRequestSource 独立保存进度，单仓库失败不阻止其它仓库输入。当前 Repository Controller 并发为一，
PullRequest Controller 并发为二；它们限制本地观察工作量，Connector 级统一配额仍属于[长期访问约束](README.md#外部访问约束长期方向)。

PR 部分失败批次仍消费成功 items，保存结构化 issues。pending=true 表示本轮还有工作，
complete=false 表示工作未完成或尚存覆盖缺口。404 不阻止下一批健康对象；pending=false 回到正常轮询。
认证、传输、覆盖错误按正常间隔退避，rate_limit 额外尊重 retryAfterMs。
Repository 页的限流提示也通过 Connector IPC 保留，失败不清空旧清单。

PR 扫描调用期限为九十秒，仓库单页读取为三十秒；repocli 内部请求限制沿用库契约。
日志记录观察范围、清单刷新时间、仓库数、子任务创建、退休、Input 身份与覆盖错误。
轮询提供当时可见的快照，不是完整事件日志；权限变化、搜索索引延迟、不可用端点仍可能造成缺口。

## 验证

tests/repository-source.test.ts 覆盖分页恢复、缓存复用、刷新失败、限流退避、幂等且有界的任务交接、
范围退出，以及真实 Runner IPC→RepositorySource→PullRequestSource→Input→Route→Chief 链路。
tests/pull-request-source.test.ts 覆盖合并接纳、冻结计划恢复、退出排空、历史去重及跨 Forge 故障隔离。
tests/forge.test.ts 与 tests/plugin-runner.test.ts 覆盖两平台仓库分页、公共事实序列化、限流提示和插件 IPC。
上述验证使用平台替身；真实 Codebase/GitHub 账号的枚举覆盖与部署效果需另行验收。
