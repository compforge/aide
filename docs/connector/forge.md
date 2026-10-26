# Forge PR/MR 变化输入

Forge Connector 提供 GitHub / GitLab 的只读访问，ForgeSource 按显式账号跨仓库发现 PR/MR，将变化保存为 Personal Input。Route 使用 PR 身份创建或复用 Topic，Chief 再决定静默更新认识、关联已有委托或沟通。Source 不直接创建 Work 或 Output。

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

GitHub 使用 GITHUB_TOKEN / GH_TOKEN，GitLab 使用 GITLAB_TOKEN；也可沿用 Connector 的 token 配置。凭证与 author 独立：author 是平台用户名，不是显示名，也不从 token 身份推断。只能发现凭证可见的仓库；Source 不要求仓库清单。Connector 的旧 uids 筛选仍用于按仓库 list，账号 discovery 始终使用 Source 的显式 author。

每个 Source id 和 forge/author 组合必须唯一，引用不存在的 Forge 在启动时拒绝。forges 省略或为空数组时不启动观察；删除配置并重启后，遗留 Source 不再执行。配置启动时解析一次，修改后重启生效。

## 发现、变化和恢复

首次分两阶段：先发现全部可见的 open PR/MR，再补充默认最近七天内更新过的对象，包括 merged / closed。首次快照也会生成 Input，供 Chief 建立背景，不强制通知用户。后续扫描固定的更新时间窗口，保留一分钟重叠，并按页保存进度。时间窗只有全部页面处理成功后才推进。

已跟踪的 open PR/MR 会直接读取，因此合并后离开 open 列表不会遗漏终态。发现失败时仍尝试复查已知对象；读取失败保留原基线，不能推断对象关闭或合并。已结束对象的基线保留 initialLookbackMs，后续重新打开可由增量发现接回。

Input 包含当前快照、前一快照和来源身份，变化覆盖生命周期、head revision、标题、评审线程及合并条件。observedAt / updatedAt 或目标分支 base revision 的单独变化不会触发 Input。完整 diff、提交明细和普通评论正文没有自动采集；现有按需评论工具仍可使用，评审线程信息不可用时明确为 unknown。

每次变化先冻结待发布计划，再写 Input，最后推进基线；pending Input 在恢复完成前受引用保护。重启恢复同一计划，已提交变化不重复生成 Input；A→B→A→B 是四次观察，使用独立发生序号。日志记录 Source、PR 身份、Input id、终态及读取失败，便于追踪输入来源。

Topic key 由 forge + 目标仓 path + PR number/MR iid 组成；fork、追加提交和 force-push 不改变该身份。同号但不同仓库的 PR 不合并。Input.relation 为 observed，authorScope 只描述发现范围，不把合并动作或他人评审归为 Me 的发言，也不授予修改或合并权限。

## 覆盖与验证

轮询记录实际观察到的状态，不保证捕获两次轮询之间的每个中间状态。单次处理最多推进五个发现对象和五个已跟踪对象，其余通过保存的游标继续；观测间隔默认五分钟。

GitHub 使用 author 限定的 PR search，单个查询窗口超过 1000 条或返回 incomplete_results 时保留检查点并报告错误，不声称扫描完成。当前尚未自动切分超大时间窗。GitLab 使用跨项目的 merge_requests 查询，按显式 author_username 和时间范围分页。API 与覆盖依据见 [GitHub Search](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests)、[GitLab Merge requests](https://docs.gitlab.com/api/merge_requests/)。

tests/forge-source.test.ts 覆盖 merged 离开发现列表、发现失败时复查、Input 写入后中断恢复、重复轮询、反复 revision 变化、跨仓同号、分页检查点，以及真实 Runner → Connector IPC → Input → Route → Chief 的处理回执。tests/forge-discovery.test.ts 覆盖两平台账号查询、分页、覆盖不足和 revision/终态映射。平台使用替身；真实账号可见范围、网络与线上部署需另外验收。
