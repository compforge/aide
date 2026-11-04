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
