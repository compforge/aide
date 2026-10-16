# Aide 的运行机制

Aide 的新增业务集中在 `src/personal/` 和 `src/channel/`。`src/runtime/` 保存从 Baton 复制的执行内核，`packages/plugin/` 保存原公共契约；本次迁入文件没有语义修改或接口改名。复制基线和文件清单见 [baton-runtime.json](baton-runtime.json)。单实例服务的文件锁仍是 Aide 的启动装配。

```text
Aide 服务进程
├── 网页 Channel → personal Intake → Work spec/status
├── Baton Session / Channel / Controller
│   └── HarnessAdapter → codex app-server → CLI
└── Baton Plugin Manager / Supervisor
    ├── Resource store / Controller / Source / Watch / cron / queue
    └── personal Worker（独立 Bun 进程）
        ├── Intake Controller → verbs.harness → 请求识别
        └── Work Controller   → verbs.harness → 推进 Task / Routine
```

## 复用边界

Runner、Supervisor、IPC、注册与撤销、Resource、Controller、Source、Watch、cron、队列、容量、退避和 verb 生命周期直接使用 Baton 实现。Harness 同样使用已有的 Adapter、Session Binding、HarnessInvocation、Turn 和事件流，不提供 Aide 自建的 `Harness.generate`。

Plugin 只经公共 Resource API 和 `ReconcileContext.verbs` 与宿主协作。Worker 不持有宿主 Store、Harness 进程或 SDK。宿主通过原有 Channel 装配 Plugin Manager 与 Harness Controller，执行先持久化，再交给 Adapter；接受请求与执行完成是不同事实。

Aide 当前装配一个常驻 Session，一个 personal Instance 和一个 Codex Target。请求识别使用主 Lane；每项工作首次执行通过 `newLane: true` 创建支线，后续继续同一 Lane，避免每次触发都创建新的执行会话。Baton 的 TUI、CLI 入口和用户级 daemon 未接入；复制的 Command、Hook 等机制仍保留原契约，网页没有为它们增加产品入口。

## Personal 工作流程

1. 网页消息按会话和消息 id 去重，建立 Intake Resource。Intake Controller 在 Worker 中调用 `verbs.harness`，校验完成 Turn 的 JSON 结果并保存路由决定。
2. personal 宿主端将决定应用到 Work。Task 与 Routine 共用 Work 身份，`spec.kind` 区分两类，转换保留 uid、历史和去重记录。spec 保存目标与触发条件；status 保存观测、问题、下次执行时间和回复 outbox。
3. Work Controller 观察 ready 或已到期的 scheduled，先保存 running，再请求 Harness 执行。正常结果、问题和状态一起写入 status。IPC 等待期间用户可能更新指令，提交结果前按 uid 重新读取资源，保留最新指令和暂停状态；版本冲突只重试提交，不重复执行外部工作。
4. ask 保存为 waiting 并结束本次调用，用户回答再唤醒。wait 返回动态唤醒时间；Routine 单次完成后保留安排，Task 则结束。事件触发改变 Work，并经过同一队列和 Reconcile。

宿主端使用 Baton 的 `replaceSpec` 和 `patchStatus` 顺序提交用户更新；status、回复和输入去重记录在同一次 status 写入中提交。没有增加跨 spec/status 的事务接口。

普通对话回复保存在 Conversation Resource；网页读取 Work / Conversation outbox。消息是持久事实，浏览器关闭不影响服务器工作。按绿地方式开发，不迁移早期 Aide 数据布局。

## 生命周期与故障

Worker 按 PluginInstance 激活，完成后注册封口。Source、Watch、Hook、Command 和 Reconcile 跨 IPC 执行；资源存储与调度留在宿主。等待 verb 时释放 Controller 和 Manager 的执行容量，verb 自己的 timeout 覆盖完整等待过程。

沿用 Baton 的策略：Worker 崩溃或超时后撤销 Binding、让未完成 verb 以 failure 收口，并取消关联执行；不自动重启 Worker，也不恢复调用栈。personal 宿主端把运行中事项标为 uncertain。重启 Aide 会创建新 Worker，但不会重复执行这些事项，用户核对外部结果后再明确要求继续。

请求识别 timeout 为 1 分钟，工作执行为 15 分钟。Aide 通过宿主现有 policy 自动批准自身发起的 Harness invocation，仍记录 Interaction 决议；不新增账号权限管理。Harness 原生权限与 CLI 凭证沿用执行环境。

## 验证与诊断

`npm run check` 执行类型检查和测试。迁入的 Baton 测试覆盖 IPC、注册撤销、资源冲突、Source / Watch、调度、verb 等待与崩溃收口；Aide 测试通过真实 Worker 和模拟 Adapter 覆盖网页交办、问答恢复、转换、事件去重、并发更新及 Worker 被杀后的 uncertain 恢复。

HTTP 和 personal 宿主日志进入标准输出；Baton 执行与 Plugin 日志保存在 AIDE_HOME 下 Session 的 `session.log`，执行事实在 `session.jsonl`。Worker 激活日志记录 pid，可与服务进程区分。真实 Codex 和业务 CLI 连通需要部署后的单独验证。
