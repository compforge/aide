# @compforge/aide-common

Dependency-free Aide error contracts shared by Host, plugins, connectors and channels.

Exports `AideError`, `AideErrorOptions` and `aideErrorDetails`. The public fields are `retryable`, `code`, `message`, and optional `biz_code`. Retrying an operation still requires the caller to check its attempt budget and replay safety.

See [the error contract](../../docs/errors.md) for ownership, wire semantics and delivery-specific extensions.
