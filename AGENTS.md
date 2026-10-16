# AGENTS.md

## 项目边界

Aide 的业务目标是小型、自托管的 personal agent；技术上是以 Channel 替代 TUI，并额外提供 personal Plugin 的 Baton。Channel 输入归入 Task / Routine，personal Plugin 的 Reconcile 通过 Harness 推进工作。按绿地视角开发，不迁移旧数据，不建设账号权限中心或共享 SDK。

除 personal Plugin、Channel 和启动装配外，优先直接使用 Baton 已有实现，不重新设计 Plugin runtime 或 Harness 接口。`src/runtime/` 的复制基线见 `docs/baton-runtime.json`；当前复制文件保持原样。修改其中机制前先说明具体产品需求与为何现有能力不能满足，不为复用主动改 Baton 仓库。

## 代码地图

```text
src/
  main.ts                  # Bun 服务入口，装配 CodexAdapter 与 HTTP
  channel/
    http.ts                # 本地 HTTP Channel
    web.html               # 网页对话、事项与安排
  runtime/                 # 原样复制的 Baton 执行内核
    plugin/runner/         # Worker / Supervisor / IPC
    plugin/                # Resource / Controller / Source / Watch / verb
    channel/               # Session 与执行组件装配；不同于网页适配器
    controller/            # HarnessInput / Queue / Turn 执行协调
    harness/               # 原有 HarnessAdapter 与 provider 协议
    store/                 # Session 与事件投影
    file-lock.ts           # Aide 服务入口的单实例文件锁
plugins/                   # 内置插件；personal 是其中一个
  personal/
    aide.ts                # Session/Plugin 装配、Intake 提交、用户更新与恢复
    plugin.ts              # 独立 Worker 入口，Intake / Work Controller
    prompts.ts             # Personal 提示词与结构化结果校验
    model.ts               # Task / Routine 业务状态
    resources.ts           # Work / Intake / Conversation 资源契约
    store.ts               # 宿主端输入提交与消息投影
packages/plugin/           # Baton 原公共 Plugin 契约
tests/                     # Baton 契约与 Aide 业务验证
scripts/install-service.sh # Linux 用户级 systemd 服务
```

## 关键约定

- Personal 业务不进入 runtime；Plugin 通过公共 Resource API 和 verbs 请求动作，不持有 Harness 或宿主 Store。
- Task / Routine 共用 Work 身份，spec.kind 区分类别；转换保留 uid、历史与去重记录。
- status、出站回复与投递去重一起提交。等待用户是持久状态，不保持执行位。
- Harness 完成不等于业务目标完成，personal 校验结果后决定工作终态。
- Worker 或 Harness 中断可能已经产生外部副作用；保留 uncertain，不自动重放。
- 用 `npm run check` 验证。真实 Worker + 模拟 Adapter 的测试不等于真实 Codex 或业务 CLI 验证。
