# Aide 的 Plugin 运行机制

Channel 接收用户消息，Intake 识别它要改变哪一项工作，保存为 Resource；Plugin Controller 观察最新状态，通过 Harness 推进工作，并把结果或问题持久化，Channel 再展示给用户。

```text
网页 / 后续飞书 Channel
        ↓ 输入、回答、事件
      Aide Intake
        ↓ 改变 Resource
Plugin Manager → Controller queue → Reconcile → Agent / Harness → CLI
        ↑                ↓              ↓
Source / Watch / cron / requeue     status + 回复 outbox
                                          ↓
                                     Channel 展示
```

## Resource 和工作

一个 Resource 的身份由 PluginInstance、namespace、apiVersion、kind、name 决定；uid 标识这次具体实例。修改 spec 推进 generation，任何业务内容变化推进 resourceVersion。写入时检查 resourceVersion，避免基于过期观察覆盖当前事实。资源独立存为 JSON，通过文件锁和原子替换提交。

Task 与 Routine 共用 `aide.dev/v1alpha1 / Work`，`spec.kind` 表示任务或安排。这样“以后每天都做”只是修改同一个 Resource，保留身份、执行历史和输入去重记录。spec 保存目标、触发条件和用户指令版本；status 保存执行状态、历史、问题、下次执行时间、出站消息和已处理输入。

Reconcile 先标记 running，再调用 Agent。完成后把状态和回复作为同一次 Resource 更新提交。用户等待状态是持久事实；询问后结束当前执行，回答改变 spec 后重新 Reconcile。进程重启将遗留 running 标为 uncertain，用户明确继续才会执行。重试观察失败与重放外部操作是两件事。

无关联工作的普通对话保存在 Conversation Resource。网页的消息流由各 Resource 的 outbox 合并，沿用消息 id 游标；Channel 不持有调度状态。事件去重记录保存在每个实际匹配的 Work 中，部分处理后重投不会重复推进已经处理的工作。

当前按绿地方式开发，不读取或迁移早期的 `state.json`。

## Plugin 生命周期

- **Package**：pluginId、version 和 activate 定义。当前通过代码导入可信 Package。
- **Instance**：可持久保存的实例 id、Package 版本、enabled 和 config。
- **Binding**：一次激活，拥有注册的 Controller、取消信号和清理函数。激活成功后注册集合封闭；激活失败或停用时逆序清理。
- **Manager**：校验 Package 与 Instance，管理 Binding、资源类型归属、共享容量和定时器。

`src/plugin/` 不导入 Aide core、HTTP 或 Codex。迁入的控制器机制包括：

| 机制 | 行为 |
| --- | --- |
| Resource / Client | namespace、标签选择、spec/status、generation/resourceVersion、owner 与级联删除 |
| Controller | 最新资源快照、每资源串行、pending 去重、运行中 dirty follow-up、删除收尾 |
| Source | 首次发现外部对象、幂等 materialize、实时唤醒、关闭时中止订阅 |
| Watch | 次级资源 create/update/delete 映射为主资源的 Reconcile key |
| CronSource | 按时区周期性重新观察一个 Controller 当前管理的所有资源 |
| requeueAfterMs | 某个 Resource 的下次观察时间，落盘并在进程启动时恢复 |
| Retry | 观察失败的指数退避，与正常唤醒使用同一队列 |
| Capacity | Controller 局部与 Manager 全局并发；suspend 同时释放两层容量 |

启动时恢复定时记录并观察现存 Resource。通知只是重新观察的提示，业务是否执行始终由当前 spec/status 决定。personal Plugin 在 scheduled 且时间未到时返回 requeueAfterMs；事件修改为 ready 后沿相同路径执行。

Baton 的终端 Command/Mention、Lane、Session/Turn 投影、审批 Inbox 和 Marketplace Worker 是它的宿主产品能力，这里没有复制。Aide 的宿主能力由 Channel 与 Harness 提供；ReconcileContext 保留执行身份、取消信号和容量挂起，而不伪造终端会话或交互。当前 Package 在进程内激活，不承诺直接运行 Baton 的任意插件。

## 增加一个 Controller

在 Package 的 activate 中注册 Controller，从 context.resources 访问资源，使用 Source 发现外部对象，使用 Watch 关联其他资源。资源持久化后，Manager 把变更路由回 Controller。读取外部系统可以直接调用已有 CLI；该 CLI 的配置和权限沿用执行环境。

```ts
const plugin: PluginPackage = {
  pluginId: "example", version: "0.1.0",
  activate(context) {
    context.registerController<{ topic: string }, { observations?: number }>({
      resourceType: { apiVersion: "example.dev/v1", kind: "Watch" },
      sources: [{ type: "cron", sourceId: "hourly", cron: "0 * * * *", timeZone: "Asia/Shanghai" }],
      async reconcile(_execution, resource) {
        if (resource.metadata.deletionTimestamp) return;
        // Observe external facts, then persist only changed status.
      },
    });
  },
};
```

先在 PluginInstanceStore 创建对应 Instance，再调用 Manager.activate 和 Manager.start。注册类型冲突会报错，不能覆盖其他 Plugin。Source.start 完成初次发现和订阅安装后应返回，长期订阅通过 signal 管理；持续阻塞 start 会阻塞启动。

Source 发射同名资源只负责确保存在并唤醒，不覆盖用户修改的 spec。Reconcile 写入 status 后会再触发观察，因此状态更新应幂等；不要每次无条件修改时间戳。外部操作失败是否可安全重试由业务 Controller 判断。
