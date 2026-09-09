# External worker controller

This document describes the local control surface introduced for issue #82. It is a second ingress to the existing ChatGPT worker/browser runtime; it does not replace or relax the Prime-owned `agents` API.

## Trust boundary

The controller listens only on `127.0.0.1` using an ephemeral port. On startup it writes `external-controller.json` in Electron's user-data directory with:

```json
{
  "version": 1,
  "url": "http://127.0.0.1:<port>",
  "token": "<capability token>"
}
```

On POSIX systems the capability file is mode `0600`. The token is generated independently from the Chrome companion credential. Every request requires `Authorization: Bearer <token>`, and requests carrying an HTTP `Origin` header are rejected so a browser page cannot use this application-control authority.

The capability file is removed when the server closes if it still contains the current token.

## External identity

An external worker is addressed by the pair:

```text
(controllerId, workerKey)
```

`workerKey` is the controller-facing identity. ChatGPT conversation IDs, browser tabs, target IDs, and bridge command IDs remain provider/runtime details. The controller never supplies or synthesizes a Prime ChatGPT conversation ID.

## Idempotency

Every mutating request supplies a durable `operationId`. The controller records the request fingerprint before browser work is published.

An exact replay of the same `(controllerId, operationId)` returns the already accepted result. Reusing the operation ID with a different payload is rejected. The operation ledger is restored across application restart.

Mutations follow this order:

```text
stage intent -> durable write -> publish browser command -> return response
```

This is intentional: an ambiguous HTTP response must not authorize a second ChatGPT side effect.

## API

All endpoints are `POST` and accept JSON objects.

### `POST /v1/workers/ensure`

```json
{
  "controllerId": "codex",
  "workerKey": "frontend",
  "operationId": "ensure-001",
  "task": "Implement the requested frontend change.",
  "model": null,
  "reasoningEffort": null
}
```

Creates the persistent worker if it does not exist. Exact operation replay is idempotent.

### `POST /v1/workers/inspect`

```json
{
  "controllerId": "codex",
  "workerKey": "frontend"
}
```

Returns the stable external worker status without requiring a Prime conversation.

### `POST /v1/workers/send`

```json
{
  "controllerId": "codex",
  "workerKey": "frontend",
  "operationId": "review-fix-001",
  "text": "Apply the review finding and re-run the focused tests."
}
```

Queues follow-up work for the same bound ChatGPT worker conversation. Exact replay does not submit the message twice.

### `POST /v1/deliveries/inspect`

```json
{
  "controllerId": "codex",
  "operationId": "review-fix-001"
}
```

Returns the stored delivery state.

## Failure semantics

The controller distinguishes pending/active/failed/ambiguous delivery states. If the runtime cannot prove whether an irreversible browser send happened, it records `ambiguous`; it does not silently replay the message. The external caller decides how to reconcile that state.

## Compatibility

Prime-owned worker families continue through the existing `agents` tool and its conversation-identity checks. External ownership is routed separately and shares only the lower-level browser worker transport. The external controller does not provide scheduling, task graphs, review/approval semantics, or multi-provider routing; those remain responsibilities of the calling application.
