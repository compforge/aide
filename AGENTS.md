# AGENTS.md

## 项目定位与边界

Aide 是一个小型、自托管的 personal agent。Channel 输入归入 Task / Routine，由 Reconcile 决定推进、等待或向用户询问；Harness 调用已有 CLI 干活。优先走通个人助手体验，暂不建设共享 SDK、Plugin 平台或账号权限中心。

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
    store.ts          # 工作、消息和去重记录的原子持久化
  harness/            # Codex 子进程协议，不理解 Task / Routine
  runtime/            # 工作队列、时间唤醒与文件锁
tests/                # 核心状态流转、Channel 联通和子进程测试
scripts/              # 用户级 systemd 服务安装
```

## 关键约定

- 单仓按目录组织，只有实际复用需求出现后再分包。修改 Aide 不要求修改 baton。
- 工作状态与出站消息一起落盘。用户回答是新的输入，等待用户时不占用执行位。
- Task 完成与 Routine 单次执行完成语义不同。时间触发与事件触发都走同一个 Reconcile。
- Harness 调用结束不意味着用户目标完成。失败或中断可能已产生外部副作用，恢复时保留不确定性。
- 模型结果在边界校验。业务编排留在 core，HTTP 和 Codex 协议分别留在 channel / harness。
- 使用 `npm run check` 检查类型和测试。测试替身与真实 CLI 验证应分别报告。
