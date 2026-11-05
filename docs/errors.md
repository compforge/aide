# Aide 错误契约

`@compforge/aide-common` 定义跨 Host、Plugin、Connector 和 Channel 的 `AideError`。两个 SDK 从同一实现重新导出它；公共层不依赖 Personal 或具体平台。普通编程异常仍可使用原生 Error，不要求全仓替换。

```ts
throw new AideError({
  retryable: false,
  code: "permission_denied",
  biz_code: "230013",
  message: "机器人不在目标用户的可用范围内",
});
```

公共字段只有 `retryable: boolean`、`code: string`、`message: string` 和可选 `biz_code: string`。`code` 是 Aide 定义的稳定分类，`biz_code` 保留外部系统错误码；平台归属来自调用上下文。`message` 是安全诊断，调用方不解析它来决定行为，也不透传 SDK 请求、凭证或原始响应。跨边界时 message 限制 4000 字符，code 和 biz_code 限制 200 字符。

`retryable` 表达同一操作在不改变业务条件时，重新尝试是否可能恢复，不表示必然重试，也不证明前次操作没有副作用。适配器解释平台错误，操作调用方结合次数上限、退避、幂等能力及结果确定性决定后续动作。无权限通常为 false；修复权限之后可以显式发起新操作。

`DeliveryError` 是 AideError 的投递专用类别，保留结果确定性和 retryAfterMs；细节见 [Connector 投递错误](connector/extensions.md#host-投递错误)。公共错误不强行携带各领域的专有字段。普通异常没有明确可重试分类；Output 仅在幂等发送且还有预算时允许未知结果重放，准备阶段异常则停止，不在投递预算之外无限重试。

Host/Runner IPC 保存并恢复四个公共字段，同时保留 DeliveryError 的专属诊断。SDK 通过结构化契约识别外部包的错误，不依赖 instanceof；恢复后的公共错误仍可通过 aideErrorDetails 读取。错误不会自动授权重新执行操作。

`HarnessError` 由 `@compforge/aide-plugin` 定义并继承 `AideError`，表示 Harness 模型调用、上下文压缩、调度或会话操作失败。`harness()` 对这些失败 reject，不再返回 `success + stopReason=error` 或字符串 failure。取消与请求期限仍返回 `dismissed`、`timeout`，操作被拒绝仍是明确的 `outcome: rejected` 回执。

`HarnessError.agent` 可携带已知的 `harness/sessionId`，使失败后的调用方仍能保存原生恢复身份。Host/Runner IPC 按 `asHarnessError` 结构化识别和恢复错误；业务层不依赖异常来自同一 SDK 副本。已有 `AideError` 保留 code、biz_code 和 retryable；未分类异常归为 `harness_operation_failed`，默认不可重试。Pi 压缩失败使用 `harness_compaction_failed`，普通终态执行失败使用 `harness_execution_failed`；不解析错误文案推断可重试性。

Personal 捕获 HarnessError 后保存未完成 Input、Topic 和 Stream 的安全诊断；`retryable: true` 也不自动重跑整个 Agent。模型请求重试与整轮业务执行恢复分属不同层，后者必须核对已发生的工具效果与业务回执。

Personal 对最终 `harness_compaction_failed` 的收尾会解除匹配的 Agent 绑定，保留失败 Input 与原生历史，供后续新输入走正常创建流程。该策略不依赖 message，也不授权重放旧输入；具体边界见 [Pi 压缩与失败恢复](harness/pi.md#压缩与失败恢复)。

新建 Harness 错误使用 `newHarnessError(code, message, agent?)`，默认不可重试。`HarnessError.from(error, agent?)` 转换已有异常并保留分类，`asHarnessError(error, fallbackAgent?)` 只识别 Harness 错误、校验跨 SDK / IPC 字段并返回错误对象。构造和补齐原生引用集中在错误定义模块；业务层直接使用 `HarnessError`，不公开独立的构造 Options 类型。
