# Local control API

Chat On Steroids exposes a separate authenticated loopback API for a trusted local controller. It uses the same durable input outbox, native ChatGPT composer delivery, session recorder, model picker, and turn stop path as the desktop app. A submitted instruction and its answer therefore appear in the app's Chat list and conversation timeline.

This interface is local process control. It is not an MCP surface exposed to ChatGPT, and it does not accept or invent browser caller identity. The app binds an ephemeral port on `127.0.0.1` and writes these files in its per-user data directory:

- `control.json`: `{"port":<number>,"protocolVersion":1}`
- `control-token`: a generated 32-byte base64url bearer token

Both files are created with owner-only file modes where the operating system supports them. A controller must never print, copy into logs, or pass the token in a URL. Read `control.json` for every new client process because the port can change after an app restart.

## Compatibility and authentication

Protocol version 1 uses HTTP/1.1 JSON. Every request must include both headers:

```http
Authorization: Bearer <contents of control-token>
X-COS-Control-Version: 1
```

The API rejects a missing or incorrect token with `401`, a version mismatch with `426`, and any request carrying an `Origin` header with `403`. Clients should connect only to the literal loopback address from `control.json`, reject redirects, set bounded timeouts, and treat an unexpected response shape as a protocol error.

Errors have one shape:

```json
{"error":{"code":"unknown_request","message":"The control request does not exist"}}
```

## Discovery

`GET /v1/capabilities` returns the protocol and app versions, whether session recording is enabled, approved filesystem roots, required delivery properties, status names, and operation names:

```json
{
  "protocolVersion": 1,
  "appVersion": "2.0.7",
  "recording": true,
  "roots": [{"name":"coin","path":"F:\\Coin"}],
  "backgroundDelivery": "app-settings",
  "exactModelSelection": "required",
  "statuses": ["queued","delivering","running","completed","failed","cancelled"],
  "operations": ["connection","connect","models","model-refresh","projects","sessions","submit","status","result","cancel"]
}
```

`GET /v1/connection` returns `{"connection":<status>}` from the app's existing connection lifecycle. The projection includes `state`, a safe display `detail`, connection evidence timestamps, tunnel health, and connector surface status. No credential is included.

`POST /v1/connection/connect` invokes the same serialized Connect operation used by the app and returns its current status. The operation is idempotent when the connection is already connected, offline-and-retrying, or starting. Because tunnel health may update asynchronously, poll `GET /v1/connection` for the terminal state and inspect `handshakeAt` for a proven round trip. Protocol v1 deliberately provides no disconnect route.

`GET /v1/models` returns the app's current native ChatGPT model catalog. Submit only when `state` is `ready`, using an exact model `id` and one of that model's exact `efforts`.

`POST /v1/models/refresh` starts a passive refresh through an already connected companion extension. It does not open or focus a browser window. A `202` response means discovery is still pending; poll `GET /v1/models` until it becomes `ready` or reports an unavailable state.

`GET /v1/projects` returns `{"projects":[...]}` from the app's project catalog. The `roots` in capabilities are the independent list of directories the user has approved; the API never creates a project or expands that list.

`GET /v1/sessions?limit=60&cursor=<opaque>` lists up to 60 recorded sessions and returns `sessions`, `total`, and `nextCursor`. Treat the cursor as opaque. `GET /v1/sessions/:id` returns one session or `404 unknown_session`. Session projections contain only `id`, `title`, `projectId`, `conversationId`, `selectedModel`, `activeTurnId`, `lastTurnOutcome`, `startedAt`, `updatedAt`, and `endedAt`.

## Submit

`POST /v1/requests` accepts one strict object:

```json
{
  "requestId": "40f68be6-1248-4c2d-aeac-f6f5eb0b6d9e",
  "submittedAt": 1788832800000,
  "sessionId": null,
  "projectId": null,
  "text": "Inspect F:\\Coin and report the current verified state.",
  "model": "gpt-5-6-thinking",
  "reasoningEffort": "xhigh"
}
```

- `requestId` is a caller-generated UUID and the authoritative durable input/outbox identity.
- `submittedAt` is Unix time in milliseconds. It may be at most one second in the future and must be within the current 24-hour idempotency window.
- Omit `sessionId` or use `null` to create a new ChatGPT conversation. Supply a listed local session id for a follow-up in that conversation.
- `projectId` is optional. If supplied for an existing session, it must match that session. It must name a project returned by the project catalog.
- `text` is trimmed and limited to 16,000 characters.
- `model` and `reasoningEffort` must exactly match the ready catalog. Unknown or stale choices fail with `422 unsupported_model_selection`; the API never falls back.

Session recording must be enabled so the API can associate the exact submitted user message with its answer. Submission otherwise fails with `409 recording_required`.

The API passes the request to the same native composer delivery path used by the desktop app. Window visibility follows the app's **Background chats** setting; the API neither overrides that setting nor implements a separate delivery or recovery loop. For an existing busy session, the stock outbox decides when the instruction can be delivered.

A new submission returns `202`. Repeating the same UUID and byte-equivalent request returns the original request with `idempotent:true` and does not send again. Reusing it with different content returns `409 request_id_conflict`.

The request ID is the stock outbox message ID. Callers may retry a submission only inside the 24-hour `submittedAt` validation window and must preserve the original ID and timestamp. Retention and compaction remain owned by the app's outbox; the adapter does not add a second receipt lifecycle.

## Status, result, and cancellation

`GET /v1/requests/:requestId` returns:

```json
{
  "request": {
    "requestId": "40f68be6-1248-4c2d-aeac-f6f5eb0b6d9e",
    "sessionId": "local-session-id",
    "state": "completed",
    "requestedSelection": {"model":"gpt-5-6-thinking","reasoningEffort":"xhigh"},
    "verifiedSelection": {"model":"gpt-5-6-thinking","reasoningEffort":"xhigh","observedAt":1788832805000},
    "createdAt": 1788832800100,
    "deliveredAt": 1788832804000,
    "result": {"text":"...","chars":1234,"truncated":false}
  }
}
```

The states mean:

| State | Meaning |
| --- | --- |
| `queued` | Durable locally and waiting for an eligible browser delivery. |
| `delivering` | Claimed by the browser delivery path; send outcome may still be ambiguous. |
| `running` | ChatGPT accepted the input, or the recorder is still waiting for exact message/model evidence. |
| `completed` | A final assistant message following this request's exact recorded `inputId` exists, and the selected model and effort were observed for the same conversation at or after delivery. |
| `failed` | Delivery failed or the associated turn ended unsuccessfully. |
| `cancelled` | The request was cancelled before confirmed completion. |

`verifiedSelection` stays `null` until the recorder proves the exact requested model and effort on the canonical user message whose `inputId` equals `requestId`. That message-scoped proof is immutable: a later follow-up may change the session's current picker without changing an older request's selection or completion. A legacy recorded row that lacks message-scoped picker fields remains unverified even if the session's latest selection happens to match; the API does not invent historical evidence. A final answer is not reported as `completed` without exact proof. Result lookup starts at the same exact user message, stops before the next user message, and never substitutes the latest assistant answer from elsewhere in the session. Full overflow text is returned up to 1,000,000 characters; `truncated` reports whether more exists.

An unknown or expired id returns `404 unknown_request`.

`POST /v1/requests/:requestId/cancel` returns `cancelAccepted` plus the current request view. Queued or browser-claimed input uses the shared outbox cancellation path. Once sent, cancellation asks the shared session turn controller to stop only the currently recorded active turn. A browser-claimed cancellation can remain delivery-ambiguous, as described by its `error`; clients must not resubmit the same instruction under a new UUID merely because cancellation was requested.
