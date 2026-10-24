# cos-continuation

Compact & Resume, the handoff brief, the held finish boundary and repair claims (unit E2.5). It
ports `src/main/session/{continuation,handoff,handoff-prompt,resume-gate,finish}.ts`,
`src/main/task-request.ts`, `src/shared/{finish,task-progress,handoff,recovery}.ts`, and the
`/compact` and `/repairs/claim` handlers of `bridge.ts`.

The bridge family `cos_bridge::families::finish::ContinuationRoutes` is the wire layer. It reads
the body and calls `Compact::answer` or `Repairs::claim`. `cos-core` builds one `Continuations`,
one `Finish`, one `Compact` and one `Repairs` (`cos-core/src/continuation.rs`), lists
`Finish::tool()` (`session_finish`) on Core, and restores the WAL right after the sessions.

## What it keeps

| Path | Written by | Notes |
| --- | --- | --- |
| `state/continuations.json` | `Continuations` | Version 1, at most 32 transactions restored. Every semantic step (open, each Send fence, the captured brief, the claim, `committing`, `committed`, `aborted`) is written before memory says so; a rejected write leaves the previous state live and is superseded. A sweep aborts what outlived its wait (30 min while a manual brief is written, 60 min under a frozen Pro selection, 10 min after capture, 6 h for an automatic ticket once asked for) and forgets ended records after 20 min. |
| `sessions/<id>/handoffs/<id>.json` | `handoff::prepare` | The bounded brief with its saved plan, version 1 provenance (source chat, generation, turn, and a SHA-256 fingerprint of the token, never the token). Published into the timeline (`handoff` event, `lastHandoffId`) only after the WAL accepted it. |
| `sessions/<id>/meta.json` | `SessionStore::rebind_session` and the two repairs | The commit moves the session to chat B (chat A stays in `chatIds`, `retiredChatAt`, `lastCommittedResumeHandoffId`); an automatic ticket abandoned before its Send refuses its turn (`autoCompactionRefusal`). |
| `sessions/<id>/events.jsonl` | this crate | `handoff`, the `Compact & Resume abandoned — <reason>` note, and the finish receipts (`progress` rows with `finishControl` `notified` or `released`), which the store folds into `finishTurn`. |

## Rules it keeps

- One transaction per session; pressing twice is the same one. One claimant, ever; the same
  claimant again is a retry. The state only moves forwards while a commit is in flight.
- The commit is preflight (the swarm handover is frozen, a run with no usable handover is
  refused), the durable session rebind, then publication (the recorder's live mapping, and
  through `Projections` the workspace and Goal). A failed rebind leaves chat A attached on disk
  and in memory and the transaction claimable again. A chat another session owns is refused.
- A restart resolves `committing` from the session: attached to B finishes the commit, still A
  makes it claimable again (`Recovered before the durable session move…`), anything else is
  refused. A handoff whose provenance names another transaction aborts it.
- Send fences: `attempted-unresolved` is written before the composer is touched and may be
  handed to another document; `dispatched-unresolved` is written before the click and is never
  replayed. A later document that still shows the pre-click newest message 15 s later hands an
  armed source click back; a page that proves the brief never left releases chat B's.
- `session_finish` holds the turn: the call must come from the session's active turn and chat,
  newer than the turn's start; one notice per turn is recorded before the desktop is told;
  queued instructions take priority; each call waits at most 25 s, rechecking every 250 ms;
  a message that must go through the browser releases the hold; End turn records `released`.

## Ports to owners that are not ported yet

| Port | Owner | With no owner |
| --- | --- | --- |
| `PrimeTransfer` | Agent broker (E2.6) | No chat leads a run: the freeze is `Absent`, nothing travels. |
| `Projections` | Workspace, Goal objective and switch (E2.7) | `cos-core` moves the recorder's live mapping only. |
| `compact::ResumeCommands` | The `resume` browser command (E2.3 ledger) | `NoResumeCommands`: the brief is stored and the job reads `opening`, but nothing opens chat B. |
| `compact::CompactChats`, `finish::FinishChats` | Workers (E2.6), automatic Goal at finish (E2.7) | No worker, no automatic chat; blocked chats come from their ledger. |
| `finish::FinishInputs` | Outbox (E2.3) | `cos-core` asks `Outbox::finish_waiting` and `finish_needs_browser`; tool delivery is not ported, so no message joins a tool result. |
| `finish::FinishNotifier` | The desktop shell | `Desktop notification is unavailable.` |
| `repairs::RepairCheck` | Browser recovery (silence, assistant errors, attribution, pickups) | Nothing is handed out, so every claim answers `{ "allowed": false }`. |

## How it is proven

- `tests/continuation.rs` runs the cases of `test/continuation.test.ts` that need no broker,
  workspace or Goal: one handoff per transaction under races and retries, a rejected WAL write,
  claims, commits (lineage, a repeated ack, a distinct chat, a failed rebind, a taken chat),
  the Send fences, deadlines, restart lifetime, provenance, reopening from a saved summary, the
  resume gate, a crash after every phase of the move, and a crash inside the commit.
- `tests/finish.rs`, `tests/compact.rs`, `tests/task.rs` and `tests/text.rs` cover the finish
  hold, the `/compact` and `/repairs/claim` answers, `test/task-request.test.ts`,
  `test/task-progress.test.ts`, the shipped prompt (byte-equal with `src/shared/handoff.ts`) and
  the bootstrap match.
- `differential/run.mjs` crashes one A to B move after each of its ten phases, restarts and
  finishes it, and crashes twice inside the commit, on the TypeScript transaction (vitest, no
  Electron window) and on this crate. It compares the answers, every file under `sessions/` and
  `state/continuations.json` with the recorder harness's `compare.mjs`. It needs
  `node_modules` at the repository root.

```sh
node rust/crates/cos-continuation/differential/run.mjs   # exit 0 equal, 1 different, 2 a side failed
```

- The `finish-tool` golden variant (`node scripts/golden/record.mjs --variants finish-tool`)
  lists `session_finish` and answers its three recorded calls as the TypeScript app does.

## Not ported yet

- The automatic Goal check at the finish boundary (`prepareNotice` with Goal or Loop on, and the
  notification's own Goal action, `requestSessionFinishGoal`): it drafts through the Goal owner
  (E2.7). `retry_task_request` and `TaskRequests` are here for it.
- The resume command itself: queueing, the redeem that claims (`claimContinuationNow` with the
  command id), the ACK that commits, placement for chat A's own browser, and the OS opener.
- `captureRecordedBrief` (capture from the recorder once the source anchor is bound) and
  `readHandoffResponse`; the page's own `summary` capture is the path here.
- `repairPrimeFromResumeShadow` (it needs the broker), automatic compaction filing from the
  context meter, the pickups and `compactionWatch`, and `staleCompanion` on `/repairs/claim`
  (the transport hands no family the shipped build's last sighting).
- Automatic Continue (the recovery tickets of `input.ts` and `bridge.ts`) belongs to browser
  recovery, not to this module family; `recovery::recovery_message` is its text.
