---
name: cos-bridge
description: Delegate work to ChatGPT through Chat On Steroids, send updates, and check CoS delivery, sessions, workers, or progress from a local agent.
---

Use Node 22+ to run `scripts/t3-code-bridge.mjs` from the CoS checkout. Resolve the checkout
from this skill's real location: three parent directories above this folder.

```text
node <checkout>/scripts/t3-code-bridge.mjs <command> [--request-file request.json] [--data-dir <CoS userData>]
```

CoS must be connected; enable Local control API and Allow actions in Settings → General →
For developers. Write UTF-8 JSON requests. Results are JSON lines; failure exits nonzero.

| Command | Request fields (`?` = optional) |
| --- | --- |
| `health` | None; advertised routes and action grant. |
| `status` | None; connection and runtime state. |
| `sessions` | `limit?` (1–50, default 20), `cursor?`. |
| `session` | `sessionId`; includes live state. |
| `agents` | `runId?`; prefer the exact run to reduce output. |
| `delegate` | `id`, `workers:[{label?,task}]`, `context?`, `sessionId?`, `projectId?`, `interrupt?`. |
| `send` | `id`, `text`, `sessionId?`, `projectId?`, `interrupt?`. |
| `inputs` | `id?`; prefer an exact message's delivery receipt. |
| `updates` | `sessionId`, `from?` (0), `durationMs?` (1–45000; default 30000), `limit?` (1–100; default 100). |

Persist a fresh lowercase UUID and request before each intended send. Delegation asks a
ChatGPT coordinator to use CoS workers; admission is not delivery or completion. Select an
exact coordinator session; older builds require one. Current builds can open a new chat by
omitting `sessionId`; `projectId` applies only then. Worker tasks/context are ≤4000 characters,
1–8 workers per request, assembled message ≤64000. Use saved model/effort defaults.

Send worker corrections through the coordinator. Set `interrupt:true` only with consent to
stop its current answer. After a send failure, inspect `inputs`; never resend `unconfirmed`
delivery. Missing outbox history does not prove non-delivery.

Save `updates.nextFrom` and reuse it; request a small `limit` for concise progress. Streaming
is used when advertised; older builds return one page. An end frame ends the read, not the
task. Upsert revised messages by message id. Collect factual worker results before claiming
completion. For detailed schemas or troubleshooting, read `docs/t3-code-bridge.md` in the checkout.
