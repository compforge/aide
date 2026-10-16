# AGENTS.md

## 项目定位与边界

Aide 是一个小型、自托管的 personal agent。Channel 输入归入 Task / Routine，保存为 Resource，由 Plugin Controller 的 Reconcile 决定推进、等待或向用户询问；Harness 调用已有 CLI 干活。开发阶段按绿地视角演进，不做旧数据兼容，不建设共享 SDK 或账号权限中心。

## 代码地图与核心模块

```text
src/
  main.ts             # 进程装配、配置、单实例锁与关闭
  channel/http.ts     # 本地 Channel 入站与出站消息读取
  channel/web.html    # 无构建依赖的网页对话与工作状态展示
  core/
    model.ts          # Task / Routine、触发与状态契约
    agent.ts          # 意图识别、执行提示词与结构化结果校验
    aide.ts           # Intake、Reconcile、问答与恢复的唯一编排入口
    store.ts          # Work Resource 与对话投影；状态、回复和去重记录一起提交
  plugin/
    api/              # Resource、Controller、Source、Watch、ReconcileContext 契约
    manager.ts        # Plugin 激活、变更路由、共享执行容量与定时唤醒
    package.ts        # Package / Binding 生命周期与激活失败回滚
    instance.ts       # PluginInstance 持久配置
    controller.ts     # 单一 Resource 类型的 Reconcile、重试和删除收尾
    resource.ts       # Resource 持久化、乐观锁、namespace 与级联删除
    resource-client.ts # Plugin 资源访问入口与变更通知
    queue.ts          # 去重、同资源串行、容量挂起和动态唤醒
    source.ts         # 外部对象发现与实时订阅生命周期
    watch.ts          # 次级资源变更到主资源的映射
    cron-source.ts    # Controller 周期性重新观察
  harness/            # Codex 子进程协议，不理解 Task / Routine
  runtime/            # 文件锁
docs/runtime.md       # 运行机制、宿主边界与扩展方式
tests/                # 核心状态流转、Channel 联通和子进程测试
scripts/              # 用户级 systemd 服务安装
```

## 关键约定

- 单仓按目录组织，只有实际复用需求出现后再分包。修改 Aide 不要求修改 baton。
- Plugin runtime 不依赖 core、Channel 或 Harness。Task / Routine 是 personal Plugin 的业务状态，避免再建一套业务调度器。
- Task / Routine 共用 Work Resource 身份，以 spec.kind 区分，转换保留 uid、历史和投递去重记录。
- 工作状态与出站消息一起落盘。用户回答是新的输入，等待用户时不占用执行位。
- Task 完成与 Routine 单次执行完成语义不同。时间触发与事件触发都走同一个 Reconcile。
- Harness 调用结束不意味着用户目标完成。失败或中断可能已产生外部副作用，恢复时保留不确定性。
- 模型结果在边界校验。业务编排留在 core，HTTP 和 Codex 协议分别留在 channel / harness。
- 使用 `npm run check` 检查类型和测试。测试替身与真实 CLI 验证应分别报告。
