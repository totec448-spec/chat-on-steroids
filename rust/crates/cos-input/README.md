# cos-input

The message outbox and the durable browser commands (unit E2.3). It ports the browser half of
`src/main/session/input.ts` with `input-attachments.ts` and the delivery record of
`input-history.ts`, and the command half of `src/main/bridge.ts` (`/commands/*` and
`state/bridge-commands.json`).

The bridge family `cos_bridge::families::input::Input` is the wire layer. It reads the body and
calls `Outbox::answer`, `Outbox::deleted_answer`, `Commands::answer` or `image_export_answer`.
`cos-core` builds one `Outbox` and one `Commands`, gives both a `Notify` that signals the wake
socket, and restores the command ledger behind the startup fence.

## What it keeps

| Path | Written by | Notes |
| --- | --- | --- |
| `state/session-input.json` | `Outbox` | One row per message (`InputEntry`). Every change is written before the caller hears of it, then the wake socket is signalled. A file that does not parse is refused (`The message outbox could not be read safely`), never replaced by an empty outbox. A temporary planner keeps only its ownership metadata on disk. |
| `state/bridge-commands.json` | `Commands` | Version 4. A lease and a final receipt are written before the page gets its answer. Restore drops commands older than 30 minutes and receipts outside the same window, and rewrites the file. |
| `sessions/<id>/...` | `cos-sessions` | A confirmed browser send becomes its chat's `user_message` (`source: app`, `inputDelivery: confirmed`), keyed by ChatGPT's message id so the page's later echo revises the same row. |
| `input-attachments/<id>` | the composer | Read only: `/input/attachment` hands out 512 KiB chunks of a file a claimed message carries. |

## Rules it keeps

- A browser claim is exclusive. A claim whose Send was never authorized can be taken over by a new
  page, including after a restart. Once Send is authorized, no page gets the text again.
- Losing an ACK is ambiguous, so an authorized send is never retried. It is released after 15
  minutes (6 hours for an automatic Continue, an opening or a combined send), and a late exact
  receipt still confirms it.
- `Native Send did not take the message.` requeues a typed message once; a second refusal fails it.
  `Native Send receipt was not confirmed.` ends the claim as unconfirmed.
- A message no page claims fails after 60 seconds; preparation that never reaches Send is cancelled
  after 60 seconds (2 minutes with images, 12 with files).
- A message without a session opens a new chat. It is filed under its own id: the outbox reserves
  a local session with that id and a desktop origin when it admits the message (again on every
  load until the message ends), and binds it to the chat the first receipt or `/input/bind` names.
- One message per chat waits for delivery; queued follow-ups wait for the turn to end and go in
  queue order.
- `deliveryProof` says what a row proves: `sent`, `not_sent`, `unconfirmed` or `pending`.

## How it is proven

- `tests/outbox.rs` and `tests/commands.rs` run cases of `test/session-input.test.ts` and the input
  and command cases of `test/bridge.test.ts` against real session files, with a hand-driven clock
  and restarts on the same profile.
- `differential/run.mjs` runs the recorded `/input/*`, `/commands/*`, `/conversation-deleted` and
  `/image-export` fixtures of `cos-types`, and the scenarios that `differential/scenarios.mjs`
  writes, through the TypeScript bridge and outbox (`startBridge` on port 0, vitest, no Electron
  window) and through this crate. It compares the answers, every file under `sessions/`,
  `state/session-input.json` and `state/bridge-commands.json`, with the recorder harness's
  `compare.mjs`. It needs `node_modules` at the repository root.

```sh
node rust/crates/cos-input/differential/run.mjs   # exit 0 equal, 1 different, 2 a side failed
```

- `differential/e2e-headless.mjs` runs the release `cos-headless` on a fresh profile with
  `CLF_BRIDGE_PORTS=0`. It records a chat over the bridge, queues one message to that chat and
  one that opens a new chat through `POST /v1/inputs`, restarts, then claims, authorizes and
  acknowledges both with the extension's headers while a wake socket listens. It finds the sent
  message in the chat, the new chat's session bound to the chat its receipt named, and both rows
  `sent` in `GET /v1/inputs`.

```sh
node rust/crates/cos-input/differential/e2e-headless.mjs rust/target/release/cos-headless.exe
```

## Not ported yet

- New chats in a project: assigning the project needs the projects owner. `enqueue` refuses a new
  chat with a `projectId`, and `/input/bind` answers `{ ok: false }` for a project row.
- Cancelling a new chat's first message keeps its empty reserved session; TypeScript deletes it
  (`removeWithdrawnOpening`), and the session store has no delete yet. The Trust registry
  (`strictChatAllowlist`) has no owner, so under strict mode a new chat stays unbound. Outbox rows
  from versions before reserved openings are not migrated.
- Tool delivery: `offerToolInput`, `acknowledgeToolInput` and the finish boundary need the kernel's
  MCP response hook. A message the policy sends through a tool result waits.
- Goal, Loop, finish and Automatic Continue (recovery, silence tickets, Goal helpers): their owners
  are E2.5 and E2.7. Rows they wrote are kept and expire by the same rules, but none is claimable,
  and `/input/progress`, `/input/answer` and the recovery branches of `/input/claim` answer as
  TypeScript does with no waiter.
- Skill framing (`prepareSkillFollowup`), Goal marker text and the image-request Core mention:
  a claimed message is its own text, plus the finish instruction on an Astra chat.
- Images and attachments for injection (`normalizeInputAttachments`), staging of new files, and
  `/image-export` saving: no export is ever registered, so every delivery answers `{ ok: false }`.
- Activity from the bridge's live pages, the kernel's in-flight call count and blocked chats:
  the policy reads the session's `activeTurnId`, sees no call in flight and no blocked chat.
- Commands: worker bootstraps, wakes and Compact & Resume replacements need the agent broker
  (E2.6) and the continuation transaction (E2.5); without them TypeScript also retires those rows
  at restore. Stop commands are complete (`queue_stop`, `pending_stops`, redeem, step, ack and
  receipts), but the Stop button's Goal, finish and continuation side effects are their owners'.
