# AGENTS.md

## 项目边界

Aide 是小型、自托管的 personal agent，由 Channel、执行内核和 Plugin 组成。Channel / Source 输入交给 Chief，普通问题直接回复，需要持续推进时才 CRUD Task / Routine；personal Plugin 的 Reconcile 通过 Harness 推进工作。按绿地视角开发，不迁移旧数据，不建设账号权限中心或共享 SDK。

personal 是内置 Plugin 之一，业务逻辑放在 `plugins/personal/`。执行、调度与恢复优先使用 `src/host/` 已有机制；修改核心接口前先说明具体产品需求与现有能力的缺口。运行机制见 `docs/runtime.md`。

## 代码地图

```text
src/
  main.ts                  # Bun 服务入口，装配 Pi / Codex Adapter 与 Channel
  channel/
    http.ts                # 本地 HTTP Channel
    feishu.ts              # 飞书单聊、持久收件与出站投递
    feishu-client.ts       # 飞书官方 SDK、长连接与发送接口
    web.html               # 网页对话、事项与安排
  host/                    # Aide 主进程：执行、调度与持久化
    plugin/runner/         # 宿主侧 Supervisor / IPC Client / 注册代理
    plugin/                # Resource / Controller / Source / Watch / verb
    channel/               # Session 与执行组件装配；不同于网页适配器
    controller/            # HarnessInput / Queue / Turn 执行协调
    harness/               # HarnessAdapter 与 provider 协议
    store/                 # Session 与事件投影
    file-lock.ts           # Aide 服务入口的单实例文件锁
  runner/                  # Plugin 子进程及 Host/Runner 共享调用契约
    process.ts             # 子进程入口：加载插件，执行 Source / Reconcile 等回调
    protocol.ts            # 双向 IPC 消息与错误序列化
    context.ts             # Plugin 调用上下文、verb 参数校验与传输接口
plugins/                   # 内置插件；personal 是其中一个
  personal/
    aide.ts                # Session/Plugin 装配、Chief 输入、问题投影与恢复
    plugin.ts              # 独立 Worker 入口，装配 Chief / Source / Work Controller
    prompts.ts             # Personal 提示词与结构化结果校验
    model.ts               # Task / Routine 业务状态
    resources.ts           # Work / Conversation 资源契约
    store.ts               # 宿主端输入提交与消息投影
    work.ts                # Work 创建/更新规则与会话范围 CRUD
    chief-model.ts         # ChiefInput 身份、观察与状态
    chief.ts               # Chief Controller，调用 Harness 与 Core ask/confirm
    source.ts              # 需求发现、水位与调度
    source-config.ts       # 关注范围和目标会话配置
agent/
  pi/                      # 内置 Pi Agent、提示词与 Work 工具
connectors/                # Meego / GitHub / GitLab 协议适配；Personal 定义关注策略
packages/plugin/           # @compforge/aide-plugin 公共契约
tests/                     # 内核契约与 personal 业务验证
scripts/install-service.sh # Linux 用户级 systemd 服务
```

## 关键约定

- Personal 业务不进入 Host / Runner；Plugin Runner 通过公共 Resource API 和 verbs 请求动作，不持有 Harness 或宿主 Store；`aide.ts` 和 `store.ts` 是宿主装配与输入投影。
- `src/runner/` 不依赖 `src/host/`。Host 可以使用 Runner 的 IPC 协议与上下文构造，但只能通过子进程入口启动 `runner/process.ts`，不能导入该入口。Resource 存储、Watch / Queue 调度、Harness 执行和 Runner 生命周期管理均留在 Host。
- Task / Routine 共用 Work 身份，spec.kind 区分类别；转换保留 uid、历史与去重记录。
- status、出站回复与投递去重一起提交。等待用户是持久状态，不保持执行位。
- Harness 完成不等于业务目标完成，personal 校验结果后决定工作终态。
- Chief 接话用 Pi，Work 执行用 Codex；Source 先提交持久 ChiefInput 再推进水位，不直接创建 Work。问答复用 Core Interaction，见 `docs/chief.md`。
- 内置 Agent 通过宿主绑定的 WorkService 操作 Personal 数据；Pi Adapter 只接收会话工厂，不导入业务模型。接入边界见 `docs/pi.md`。
- Worker 或 Harness 中断可能已经产生外部副作用；保留 uncertain，不自动重放。
- 用 `npm run check` 验证。真实 Worker + 模拟 Adapter 的测试不等于真实 Codex 或业务 CLI 验证。
