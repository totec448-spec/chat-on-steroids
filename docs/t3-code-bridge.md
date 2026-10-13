# Direct T3 Code orchestration through CoS

The Node 22+ CLI `scripts/t3-code-bridge.mjs` lets a local T3 Code agent own orchestration
and drive CoS's native broker workers directly. There is no ChatGPT coordinator conversation:

`T3 orchestrator -> CLI -> CoS local API -> existing broker -> ChatGPT workers`

The broker still owns capacity, identity, durable admission, workspace isolation, messages,
sleep/reuse and reports. MCP and local callers share admission code in `agent-admission.ts`.
The CLI stores no separate worker database and makes no model calls of its own.

## Setup and updates

Use a CoS build containing the v1 worker routes below. Enable **Local control API** and
**Allow actions** in Settings -> General -> For developers, enable multi-agent workers,
and complete CoS's normal ChatGPT/Core/browser setup. See [Setup](setup.md).

The short [cos-bridge skill](../.agents/skills/cos-bridge/SKILL.md) lists every CLI operation.
Link its folder into your user skills directory to use it across projects; resolve the
checkout using the skill folder's real location. No extra MCP server or API key is needed.

The bridge discovers the ephemeral loopback endpoint and per-launch token from CoS userData.
Credentials stay out of arguments/results; requests go only to 127.0.0.1 without redirects.
The existing filesystem token and action grant protect local worker control, just as they
protect ordinary chat sends. `ownerId` is a durable routing identity, not an authentication
secret or a claimed ChatGPT conversation. MCP tool arguments cannot set that local principal.

The client uses advertised versioned API routes, not Electron internals, database writes,
private browser endpoints or imported application modules. Additive CoS changes need no CLI
change; a build without the v1 worker surface returns `worker_broker_unavailable` before
a worker mutation. It never falls back to a coordinator. Older installed versions require
an updated CoS build. Maintaining the upstream API preserves this integration across releases;
a future breaking API change still requires deliberate client adaptation.

## Requests

Write UTF-8 JSON files; use a persistent lowercase UUID `ownerId` for each T3 task.
Preserve returned `runId` and worker ids; a sleeping family gets a fresh incarnation when
revived, and the broker keeps bounded former-run selectors for its own caller.

`node /path/to/chat-on-steroids/scripts/t3-code-bridge.mjs delegate --request-file job.json`

Example `job.json`:

```json
{
  "ownerId": "11111111-1111-4111-8111-111111111111",
  "context": "Repo /path/to/project. Read AGENTS.md. Read-only audit; report specific evidence.",
  "workers": [
    { "label": "Architecture", "task": "Inspect module boundaries." },
    { "label": "Tests", "task": "Inspect behavioral test coverage." }
  ]
}
```

An optional known `projectId` selects CoS's approved project workspace. When automatic
worktrees are enabled, this uses the same allocation and permission checks as MCP worker
spawn. Without a project, supply approved absolute repo paths in context; no workspace is
guessed. Worker models/effort come from saved CoS defaults. A spawn admits workers as invited;
it does not prove the browser has started or completed their assignments.

All commands print JSON lines and exit nonzero on failure. Unknown fields are refused.
`--data-dir <directory>` overrides CoS userData; defaults are the normal Windows APPDATA,
macOS Application Support or Linux XDG config locations for `chat-on-steroids`.

| Command | Request fields |
| --- | --- |
| `health`, `status` | None: advertised capabilities or connection/browser/runtime state. |
| `delegate` | `ownerId`, `workers` (1–8; task/label), optional `runId`, `context`, `projectId`. |
| `message` | `ownerId`, `messages` (1–16; to/text/optional label), optional `runId`. |
| `agents` | `ownerId`, optional `runId`: compact worker state, exact session ids, free slots and parked history. |
| `reports` | `ownerId`, optional `runId`: unread messages/reports with receipt ids and run ids. |
| `ack` | `ownerId`, `messageIds` (1–128 opaque returned ids), optional `runId`. |
| `sessions` | Optional `limit` (1–50; default 20), `cursor`: one session page. |
| `session` | `sessionId`: exact session and live projection. |
| `updates` | `sessionId`, optional `from` (default 0), `durationMs` (1–45000; default 30000), `limit` (1–100; default 100). |
| `send` | Ordinary chat: `id`, `text`, optional `sessionId`, `projectId`, `interrupt`. |
| `inputs` | Optional ordinary message `id`: exact delivery receipt or recent outbox rows. |

Worker task/context/message text is limited to 4,000 characters; labels to 60. Reuse a
suitable sleeping worker with `message` before spawning a replacement. Broker status omits
task bodies and results; read `reports` only when collecting new work. Reports are offered
at least once: save them before `ack`, and deduplicate receipt ids when re-reading. A status
read never acknowledges reports. Local owner ids persist in the broker's existing v7 snapshot
through parking/restart; they cannot select another owner or an unrelated ChatGPT prime.

After a timeout or lost response, inspect status/reports before retrying a worker mutation.
The CLI never automatically retries it. Use `updates` with a worker's returned `sessionId`
to inspect progress; save the final `nextFrom` cursor. Streaming is used when advertised,
otherwise one cursor page is returned. Sequence revisions need not be chronological; upsert
by message id. End reasons `duration`, `limit`, `page`, `stopped` and `max_duration`
finish the read, not the task. Failed streams return a consumed cursor and exit nonzero.
Raw tool arguments/results are excluded. Keep private returned history local.

Ordinary `send` is separate from broker messaging. Persist a new UUID before each intended
chat message, inspect `inputs` for delivery, and never resend `unconfirmed` delivery. Missing
outbox history does not prove non-delivery. Worker chats are controlled with `message`, not
ordinary `send`. `interrupt:true` consents to stopping an ordinary chat's current answer.

## API contract

Authenticated GET `/v1/workers/{ownerId}` and `.../reports` accept optional `runId`.
POST `.../spawn`, `.../message` and `.../ack` use the corresponding command bodies without
`ownerId` (it is in the path). They share the existing action gate, framing, size/rate bounds,
serialization and deadlines. Saved model defaults and browser handout remain broker-owned.

## Verification

`npx vitest run test/t3-code-bridge.test.ts test/control-api-workers.test.ts`

CLI tests use fixture credentials and real loopback HTTP; direct-control tests also use the
real broker/durable admission with provider/browser boundaries simulated. They cover spawning
without a ChatGPT prime, worker reports/ack/reuse, restart ownership, foreign-run refusal,
action revocation during persistence, event cursors and transport failures. `npm run verify`
is the full project gate. Live direct-worker acceptance requires a build advertising this API.
