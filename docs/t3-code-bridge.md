# T3 Code to ChatGPT through CoS

`scripts/t3-code-bridge.mjs` is a dependency-free Node 22+ command-line bridge for T3 Code and
other local agents. It connects to CoS's existing authenticated local control API. CoS remains
the owner of chats, message delivery and workers; the bridge keeps no separate task database.

```text
T3 Code -> CLI -> CoS local control API -> ChatGPT coordinator -> CoS agents workers
T3 Code <- CLI <- session events / delivery receipts / worker state
```

Delegation is a request to a ChatGPT coordinator to use the CoS `agents` tool. Acceptance by
the outbox does not prove the coordinator followed the instruction or spawned workers. Check
the coordinator's recorded updates and actual broker state. Direct writes into worker chats
remain refused by CoS; send corrections or worker follow-up requests to the coordinator.

## Setup

1. Install and connect CoS and its ChatGPT Core connector as described in [Setup](setup.md).
2. Enable multi-agent workers in CoS and retain your preferred model/effort defaults.
3. In **Settings -> General -> For developers**, enable **Local control API**. Enable
   **Allow actions** for delegation and messages. These switches grant the access documented
   in [Local control API](setup.md#local-control-api); the bridge never changes them itself.
4. Keep this checkout on the same computer as CoS. Give T3 Code the absolute script path.

No additional MCP server, API key, public tunnel or T3 source patch is required for the CLI.
The short [`cos-bridge` skill](../.agents/skills/cos-bridge/SKILL.md) lists every command for
agents using this checkout. To use it across projects, link its folder into your user skills
directory; its checkout resolution uses the linked folder's real location.
The existing CoS-to-ChatGPT connection still needs its normal setup. Credentials are read
from CoS's per-launch `control-api` files and stay out of arguments and results. The CLI binds
requests to `127.0.0.1`, follows no redirects, and never retries a mutation automatically.

## Invoke from T3 Code

Write requests as UTF-8 JSON files rather than interpolating messages into shell commands:

```powershell
node "C:/path/to/chat-on-steroids/scripts/t3-code-bridge.mjs" health
node "C:/path/to/chat-on-steroids/scripts/t3-code-bridge.mjs" sessions
node "C:/path/to/chat-on-steroids/scripts/t3-code-bridge.mjs" delegate --request-file delegate.json
```

`--data-dir <directory>` overrides the CoS user data directory for a custom installation.
Otherwise it uses `%APPDATA%/chat-on-steroids` on Windows, `~/Library/Application Support/chat-on-steroids`
on macOS, or `$XDG_CONFIG_HOME/chat-on-steroids` (default `~/.config`) on Linux.

Generate a fresh lowercase UUID for each intended message and store it **before sending**.
Keep that UUID and request file for delivery reconciliation. Example `delegate.json`:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "sessionId": "22222222-2222-4222-8222-222222222222",
  "context": "Repository /path/to/project. Read AGENTS.md. Read-only audit; do not edit files.",
  "workers": [
    { "label": "Architecture", "task": "Inspect the module boundaries and report specific findings." },
    { "label": "Tests", "task": "Inspect test coverage and report missing behavioral cases." }
  ]
}
```

Use an explicitly selected coordinator session from `sessions`. Current GitHub builds also
allow omitting `sessionId` to open a new coordinator, optionally with `projectId`. The new
session id equals the input UUID. Some installed builds report the same protocol/version
but require an existing `sessionId`; an `invalid_body` response does not trigger a retry or
automatic chat selection. Create a chat in CoS and supply its exact session id in that case.

The bridge asks the coordinator to reuse suitable sleeping workers, respect capacity,
omit model/effort overrides, prohibit nested delegation, report run/worker ids and collect
reports before finalizing. There may be fewer concurrent slots than requested assignments.

## Commands and request fields

Each invocation prints JSON lines on stdout and exits nonzero on failure. Unknown fields and
malformed ids are refused before a request is sent. Commands with no fields need no request file.

| Command | JSON request | Result |
| --- | --- | --- |
| `health` | none | App version, protocol, advertised routes and action grant. |
| `status` | none | Existing connection, browser bridge and in-flight tool state. |
| `sessions` | Optional `limit` (1–50, default 20), `cursor`. | One session page, including `nextCursor`. |
| `session` | `sessionId`. | Exact session plus its existing `live` projection. |
| `agents` | Optional `runId`. | Existing broker state, optionally filtered by exact run incarnation. |
| `delegate` | `id`, `workers` (1–8); optional `sessionId`, `projectId`, `context`, `interrupt`. | Outbox response plus `delegation: "requested"`. |
| `send` | `id`, `text`; optional `sessionId`, `projectId`, `interrupt`. | Outbox admission/replay response. |
| `inputs` | Optional `id`. | Recent outbox rows, or the exact row and a retention warning. |
| `updates` | `sessionId`; optional `from` (default 0), `durationMs` (1–45000, default 30000), `limit` (1–100, default 100). | Event lines, then `{ "end": "…", "nextFrom": … }`. |

`projectId` applies only to a new chat. `interrupt:true` explicitly consents to a send that
would stop the answer being written. Ordinary messages never set it by default. Worker tasks
and shared context are limited to 4,000 characters, matching the CoS agents schema. Message
text, including serialized delegation assignments and coordinator instructions, is limited
to 64,000 characters. Use saved defaults for model and effort.

## Follow work and send updates

After admission, use `inputs` with `{ "id": "<input UUID>" }` to inspect delivery. The verdicts
come from CoS: `pending`, `sent`, `not_sent`, or `unconfirmed`. A timeout or a lost connection
can happen after admission; the error includes `inputId` so you can reconcile it. **Never
resend an unconfirmed delivery.** A missing row can be evicted history, so it does not prove
that the message never arrived. Idempotent replay lasts only as long as CoS retains the row.

Use `updates` with `{ "sessionId": "<coordinator session>", "from": 0 }`. It streams when
`health.routes` advertises the stream route; otherwise it returns one existing event page.
Each event has a `nextFrom` sequence cursor. Persist the final cursor and pass it back on the
next read. Revisions to the same message get new sequences; a timeline should upsert by
message id rather than append every revision as a separate message. `duration`, `limit` and
`page` end a read, **not the task**. An interrupted stream returns the last consumed cursor
and a nonzero exit. The bridge does not automatically reconnect.

Updates include user/assistant messages, progress, agent messages, turn boundaries and chat
errors. They exclude raw tool arguments/results. Text is already redacted and bounded by CoS,
but arbitrary private text can still be present: keep returned history local.

To give ChatGPT a correction, use `send` with a fresh UUID, the exact coordinator `sessionId`,
and `text`. To follow up with a worker, ask that coordinator to message the returned worker
id within its exact run. `agents` is the global local-control projection, distinct from the
caller-scoped MCP `agents status`; a `runId` filter does not grant additional authority.

Suggested standing instruction for a T3 task:

> Use the CoS bridge at the supplied absolute path. Delegate only authorized bounded work.
> Persist a UUID and request JSON before sending. Distinguish admission, delivery, worker
> activity and completion. Read updates with the saved cursor, and return factual worker
> reports to me. Keep messages, credentials and local paths out of public evidence.

## Verification

```powershell
npx vitest run test/t3-code-bridge.test.ts
npm run verify
```

The CLI tests use real child processes and an isolated loopback HTTP server with fixture-only
credentials. They cover delegation, messages, delivery, runtime projections, streaming/page
cursors, fragmented UTF-8, bounded reads, refusals and lost acknowledgements. They contact no
installed CoS app or provider. Live acceptance additionally requires sending a harmless task
to an explicitly chosen coordinator and observing its actual worker result.
