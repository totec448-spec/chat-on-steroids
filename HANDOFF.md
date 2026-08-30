# Handoff — selective 2.0.3 rebuild on the public GitHub baseline

**Branch:** `rebuild/2.0.3-from-2.0.2`  
**Baseline:** `HEAD = 9e27c0f`, exactly equal to `origin/main` before the current working-tree edits  
**Written:** 2026-08-30  
**State:** work in progress; shared dirty tree; focused seam and typecheck are green.

This document replaces the previous stale handoff. Goal tests are no longer red, the command
tranche is implemented, and several later lifecycle/UI requirements have landed.

---

## 1. Mission and binding rules

The user started from the exact current public GitHub repository and wants only the useful 2.0.3
behaviour reintroduced, made compatible with this baseline. The reference branch
`proof/2.0.3-native-matrix` may be inspected for behaviour, but must not be merged or bulk-ported.

The literal first rule in `AGENTS.md` governs every edit:

> **Quality >> quantity.** Prefer deleting or replacing old code over adding new machinery; every
> change should make the codebase smaller, simpler, and more maintainable where possible. Do not
> bloat the codebase.

Practical constraints:

- Preserve the shared dirty tree. Never reset, checkout, clean, bulk-format, or overwrite unrelated
  work. There are mixed staged and unstaged edits.
- Find the earliest wrong identity or state transition. Do not repair downstream symptoms with a
  guessed active tab, parallel state machine, repeated fallback, or arbitrary delay.
- Reuse existing authorities. Continuation owns Compact & Resume after semantic send; the revive
  command owns the 30-second waking deadline; exact attributed caller activity proves a Worker is
  alive; recorder owns when a call becomes Unattributed; the extension owns tab/conversation truth.
- Keep source/test/package/installed/live-browser proof separate. Current proof is source, focused
  tests, typecheck, and limited signed-in Chrome observation. No new package or installed-artifact
  proof exists for this working tree.
- Keep comments short and invariant-focused.
- Public-repo rules in `CLAUDE.md` remain binding: no private ChatGPT/Codex URLs, provenance
  trailers, or private conversation IDs in committed files.

### Exact current size and verification facts

- Current total diff: **42 files, +1067/-543**.
- Source/runtime only after compression: **+485/-274, net +211**.
- Focused seam: **798 passed + 1 intentional skip**.
- Typecheck: **green**.

Do not replace these with the obsolete figures in the former handoff.

---

## 2. Requirement ledger

| Requirement | State | Contract |
| --- | --- | --- |
| Exact current GitHub repository baseline | Done | Work began at `9e27c0f == origin/main`; preserve the current dirty diff. |
| Import useful 2.0.3 command/tool changes narrowly | Done | PowerShell 5.1 operator normalization, UTF-8 `Get-Content`, live-root wording, retired `max_output_tokens`, and search/exit hints. |
| Remove idle `Compact` pill/text | Done | Hidden in idle/off only; active compact controls and tooltip remain. |
| Put quality/less-code rule first in AGENTS.md | Done | Do not recreate the deleted duplicate `agent.md`. |
| Open Chat button beside Delete | Done | Exact valid ChatGPT conversation opens in preferred Chrome/Chromium; invalid/unattributed session fails closed. |
| Allow unattributed calls setting | Done | Default false; bypasses ambiguous no-ID guards only, never proven retired/dormant/ended Worker fences. |
| Default Goal model GLM 5.3 | Done | `z-ai/glm-5.3`; explicit user model choices are not overwritten on save. |
| Short Goal failure/retry mode | Done | Retry is allow-listed and bounded; abort, deterministic failure, and valid structured stop are terminal. |
| Goal fires only after real non-partial finish | Source boundary done | Only `completed` is Goal-continuable. Continue end-to-end reliability audit after TODO #10. |
| Worker waking maximum 30 seconds | Done | Existing revive command is the authority; browser Send ACK is delivery, not model liveness. |
| Auto-compaction retryability | Done | Duplicate durable auto-claim deleted; existing continuation owns exactly-once after semantic send. |
| Explicit page interruption repair | Done | Exact DOM notice produces an exact-tab one-shot reload. This is separate from TODO #10. |
| Exact Worker IDs in bottom Chat settings | Done | Rows show IDs such as `worker-3`, not generic repeated `worker`. |
| TODO #10 Unattributed recovery | Done | Durable Unattributed -> exactly 20s -> the browser reloads that exact tab; detached worker chats reopen. See §6. |
| Windows/Linux updater + top notice | **Not implemented** | No updater exists in the current diff. Implement after TODO #10 with one owner. |

---

## 3. Implemented behaviour in detail

### 3.1 Command/tool tranche

- `src/main/codex/shell.ts` identifies Windows PowerShell 5.1 from the resolved shell path.
- `src/main/exec-hints.ts::normalizePowerShellOperators()` rewrites only simple top-level
  `&&`/`||` for Windows PowerShell 5.1. It reuses the existing top-level parser; do not restore a
  second parser.
- `src/main/mcp/tools-core.ts` applies the rewrite after command binding.
- `src/main/exec.ts` makes PowerShell `Get-Content` read UTF-8 explicitly.
- Tool schemas/instructions derive examples from live approved roots and warn about PowerShell 5.1
  only when it is the actual selected shell.
- `max_output_tokens` remains accepted at the MCP boundary but ignored. The retirement note is
  shown only when the caller sends the field. Internal runtime fields remain required.
- Search/nonzero-exit notes extend the small existing 2.0.2 behaviour rather than importing the
  large 2.0.3 hint subsystem.

Primary coverage: `test/exec-hints.test.ts`, `test/exec.test.ts`,
`test/exec-output-budget-mcp.test.ts`, `test/mcp.test.ts`.

### 3.2 Goal model, retry, and completion boundary

- `src/main/config.ts::DEFAULT_GOAL_MODEL = 'z-ai/glm-5.3'`.
- Parsing/defaulting preserves legacy config, while an explicitly selected model is never rewritten
  by a normal settings save.
- `src/main/goal.ts::requestGoalDecision()` is the shared retry seam for normal Goal drafts and
  opening-message drafts.
- Maximum attempts: 3.
- Retry is allow-listed: transient HTTP 408/425/429/5xx, explicit provider
  stream/completion failures, and genuine fetch/transport exceptions.
- Auth, credit, unknown-model, parse/programming errors, abort/revocation, and valid structured stop
  remain terminal.
- The abort signal is re-read inside `catch`, after the awaited failure, preventing a revoked draft
  from issuing a second request.
- Empty or `[no reply]` pseudo-decisions retry under the bounded policy.
- `extension/content.js::GOAL_CONTINUABLE` contains only `completed`.
  `stopped` is user intent; `interrupted`, `failed`, `stalled`, and `unknown` belong to
  repair, not Goal.

Primary coverage: `test/goal.test.ts`.

### 3.3 Worker revival: delivery is not liveness

The final implementation deliberately added no timer map or agent timestamp fields:

- The existing revive command's `createdAt + 30_000` deadline is the absolute waking ceiling,
  including browser absence and owner-null redemption.
- Browser `sent` ACK proves only that ChatGPT accepted the revive prompt. It does not move
  `waking -> active` and does not permanently consume the Worker slot.
- Existing `lastRevivalCommandId`, `offeredViaRevival`, `offeredAt`, and
  `workerRevivalDeliveredSince()` provide restart-durable delivery evidence.
- A delivered revive remains temporarily non-deliverable so it neither resends nor blocks unrelated
  browser commands.
- `mcp/kernel.ts::noteAgentAlive()` activates the exact Worker only after proven caller
  attribution.
- At 30 seconds, `failUnresponsiveWorkerRevival()` returns it to sleeping/revivable while
  preserving the already-sent offer. The same user text is not typed twice.
- A late exact call remains idempotent and may acknowledge the preserved offer.

The obsolete bridge case expecting owner-null waking after 31 minutes was replaced with expiry ->
same Worker sleeping/revivable, inbox intact. The no-renew-at-redeem 30-second regression remains.

Primary coverage: `test/agents.test.ts`, `test/bridge.test.ts`.

### 3.4 Auto-compaction: continuation is the durable authority

The old design permanently spent `autoCompactTriggeredAt` before ChatGPT stopped and before
pending tools settled. Any transient pre-send failure then disabled auto-compaction forever.

Current smaller design:

- Deleted `SessionSummary.autoCompactTriggeredAt`, `claimAutoCompaction()`,
  `/compact/claim-auto`, background `auto_compact_claim`, and dead fake handlers/comments.
- `content.js::maybeAutoCompact()` starts from the live threshold and current in-turn state.
- Existing page `nativeBusy`/`job.busy` suppresses concurrent attempts.
- Existing current-generation `localError` prevents an immediate storm and clears on the next
  generation.
- A stop/tool-settle failure before the prompt crosses semantic send may retry later.
- After semantic send, the existing durable continuation transaction is the only exactly-once
  authority.
- Successful rebind naturally resets the replacement chat's context level.

Removing the bridge route bumped `BRIDGE_PROTOCOL` 8 -> 9. Production has no compatibility
endpoint. Only intentional negative tests should still mention `auto_compact_claim`.

Primary coverage: `test/session.test.ts`, `test/content-script.test.ts`,
`test/continuation.test.ts`, `test/bridge.test.ts`, `test/extension.test.ts`.

### 3.5 Allow unattributed calls

One boolean was added to the existing `multiAgent` setting, default false:

- Types/config parsing: `src/shared/types.ts`, `src/main/config.ts`.
- Validation and existing three-way settings merge: `src/main/ipc.ts`.
- Checkbox beside Sub-agent Workers: `src/renderer/index.html`, `src/renderer/chat.ts`.
- Policy: `src/main/mcp/kernel.ts`.

When enabled it bypasses only ambiguous/no-conversation guards:

- `retiredLeaseAmbiguous`;
- `dormantLeaseAmbiguous`;
- identity-sensitive + swarm-running + no conversation.

It never bypasses proven `retiredWorker`, `dormantWorker`, or `endedWorker`. Recorder and
correlation repair remain unchanged, so calls remain visibly Unattributed. Relative/defaulted
workspace calls without identity still fail honestly rather than guessing another chat's folder.

Primary coverage: `test/config.test.ts`, `test/ipc.test.ts`,
`test/renderer-state.test.ts`, `test/feature-parity.test.ts`, `test/agents.test.ts`.

### 3.6 Open Chat and exact Worker IDs

- `src/renderer/chat.ts` adds Open Chat beside Delete and stops row propagation.
- `src/preload/index.ts` exposes only `openSessionChat(id)`.
- `src/main/ipc.ts::sessions:openChat` loads the durable summary, requires a valid conversation
  ID, constructs the exact ChatGPT URL, and calls `openInPreferredBrowser()`.
- Unattributed/no-conversation sessions fail closed.
- Bottom live swarm rows now show `agent.label || agent.id`, plus an exact ID chip when the label
  differs. The generic role chip was removed; Clear already uses exact `agent.id`.

Primary coverage: `test/ipc.test.ts`, `test/renderer-layout.test.ts`.

### 3.7 Explicit DOM connection interruption reload

This completed repair is intentionally separate from TODO #10:

- `extension/content.js` reuses `CLF_DOM.errors()`.
- It recognizes the exact normalized visible notice:
  `Connection interrupted. Waiting for the complete answer`.
- It requires Stop absent, no manual user stop, exact conversation ID, and the newest stable
  user-message ID.
- `sessionStorage` stores `conversationId + messageId`; it survives reload and prevents a loop
  without new durable app state.
- Content sends `reload_interrupted_chat`.
- `extension/background.js` verifies the sender document owns that exact conversation, then
  reloads only that tab.
- It does nothing while Stop is present and refuses stale/wrong-conversation documents.

TODO #10 may share a neutral exact-owned-tab reload action only if that deletes code. Its trigger,
20-second incident, eligibility, and recheck must remain independent.

Primary coverage: `test/content-script.test.ts`, `test/extension.test.ts`.

### 3.8 Compact pill

`extension/content.js::renderControl()` hides the text pill while mode is `idle` or `off`.
The actual compact button, meter, active state, and tooltip stay intact.

---

## 4. Live ChatGPT evidence already gathered

The user explicitly authorized messaging, stopping, reloading, and monitoring a prepared signed-in
Chrome chat. Do not put its URL or conversation ID into public files.

Observed:

1. A broken response rendered the exact page notice
   `Connection interrupted. Waiting for the complete answer`; Stop was absent. Reloading that
   exact existing chat in place was safe and restored it. This drove §3.7.
2. Auto-compaction triggered around the configured 400k threshold. It waited for the current turn,
   sent the dedicated handoff request, durably recorded the continuation, opened a fresh chat,
   rebound the same local session, folded the handoff into the replacement, reduced the context
   estimate substantially, and resumed attributed activity.
3. The idle composer showed the meaningless `Compact` pill; the current change hides only that
   idle/off presentation.
4. A visible page safety/error retry surface must not count as a completed assistant answer. The
   completed-only Goal boundary protects drafting; full recovery still needs TODO #10/live replay.

`docs/chatgpt-turn-signals.md` records source and live findings. Preserve these distinctions:

- ChatGPT DOM/message-stream failures and OpenRouter Goal-provider failures are separate domains.
- `endOutcome()` is not the only turn-ending writer; recorder close may write
  `turn_end: unknown`.
- `readEvents` is exported by `src/main/session/store.ts`, not recorder.

---

## 5. Verification evidence

Latest focused seam:

```text
npm.cmd run typecheck
  PASS

npx.cmd vitest run test/content-script.test.ts test/extension.test.ts
  test/agents.test.ts test/config.test.ts test/ipc.test.ts
  test/renderer-state.test.ts test/renderer-layout.test.ts
  test/feature-parity.test.ts test/exec-hints.test.ts
  test/exec.test.ts test/goal.test.ts
  798 passed + 1 intentional skip
```

Earlier focused lifecycle runs also passed:

- Worker/bridge seam after the 30-second fix and stale-test replacement: 241/241.
- Auto-compaction session/content seam after claim removal: 379/379.
- Earlier settings/lifecycle group: 592/592.

These are focused source tests, not full-release proof. Before completion rerun:

```powershell
npm.cmd run typecheck
npx.cmd vitest run test/bridge.test.ts
npm.cmd test
npm.cmd run build
```

Then run the privacy gate before any commit. Do not pipe Vitest through a command that loses its
exit status.

---

## 6. TODO #10 unattributed recovery, as built

`src/main/bridge.ts` owns one incident and nothing more. The recorder's post-grace verdict on a
finished call is the only input: an unattributed one opens the incident (once — a broken join
files a call every few seconds, and a renewing deadline never fires), an attributed one clears
that chat. Twenty seconds later exactly one candidate is repaired, or none is. Candidates are
only chats the app can prove are mid-turn: `liveConversations().generating`, plus workers whose
tab went away mid-turn (`detached`). Two candidates or none both mean "do nothing".

Who carries the repair out is split at the one boundary that knows:

- **Not detached.** The app queues the repair and hands the conversation id out on `/status`.
  The extension collects it on the `RETRY_ALARM` maintenance pass it already runs — kept running
  while it holds any ChatGPT tab, because a dead reporter is exactly the case where no page will
  wake a stopped service worker — resolves it against `tabConversations`, and reloads that exact
  tab. The app never opens a url for these, which is what stops the repair from being a
  duplicate tab of a chat still on screen.
- **Detached.** No document exists, so `openInBrowser` reopens the chat. Nothing to duplicate.

**A repair is only spent once it actually happened.** `/status` is the whole conversation: a
pass reports the repair it carried out (`?repaired=<token>`) and gets the next one. A pass that
reports nothing is the verdict on the last handout — no tab of that chat, two of them, a reload
that threw — and the repair goes back in the queue and is handed out again under a **fresh
token**. The token, not the conversation id, is what a receipt has to quote: a chat outlives
several repairs, and a late receipt for a spent one would otherwise mark the current broken turn
repaired and leave it broken forever. The detached open is the app's own action, so a rejection
there deletes the entry outright. Nothing but success moves a repair to `done`.

**A repair belongs to one broken turn**, not to a chat forever, and the turn *ending* is the only
thing that spends it: `repairsInFlight` stores the chat's `endedTurns` count at the moment the
repair was filed, and `retireSpentRepairs()` drops the entry when the chat's count has gone up.
Not the turn id — the reload changes that. A replacement document re-observes a generation that
never ended and mints a new local turn id for it, so a repair pinned to an id looked spent
seconds after its own reload landed; the still-dead join produced the next unattributed call, and
twenty seconds later the same chat was reloaded again, for as long as ChatGPT stayed broken. One
reload per failure. What ends a repair early is proof it worked — an attributed call from that
chat — which is also what makes the next break in it repairable.

State is two things: the open incident (timer + the chats that proved themselves during it) and
`repairsInFlight` (`endedTurns` + `queued`/`handed`/`done` + the handout token). Nothing expires
on a timer.

Regressions live in `test/bridge.test.ts` (`unattributed activity recovery`: the 20s boundary,
no renewal, attributed calls calling it off, page liveness not counting as proof, ambiguity,
completed/stopped exclusion, re-handing an uncarried-out repair, repairing a later turn in an
already-repaired chat, **not** reloading again when the reload did not restore the join, a stale
receipt closing nothing, a detached open that failed being tried again, and a worker chat that
came back and went away again) and `test/extension.test.ts` (`unattributed chat repair from the tab
registry`: exact tab reloaded and reported; two tabs refused until one closes; a reload that
threw retried; nothing opened for a chat this browser does not hold; the alarm kept alive by
held tabs).

### The request-id join is permanent

`src/main/session/correlation.ts` is the only ownership join, and since v5 of its durable index
the binding is one-way: the first conversation to prove a request id owns it, and a second one
claiming the same id is **refused** rather than believed. There is no sticky `conflicted` verdict
any more, and no `requestCorrelationConflicted()`.

The old rule destroyed the owner on disagreement (`value = null`, permanently), which is exactly
the failure the user saw in the log: every later call of a workflow that was still running waited
the full `REQUEST_ID_GRACE_MS` for evidence that could no longer be accepted and landed in
Unattributed activity. A page that disagrees is a page that is wrong about itself — a React tree
still mounted from the chat before it, a fresh chat whose client thread id has not caught up —
and refusing it costs that page nothing that was ever really its own. A refusal is logged once
per batch at **info**, not warn: nothing is lost, so it is not a problem in the Activity panel.

History replay on restore now merges **oldest session first**, because first-proof-wins only
means anything if "first" is first in time; `listAllSessions()` returns newest-first.

---

## 7. Updater, as built

`src/main/update.ts` is the one owner: GitHub releases API, `SHA256SUMS.txt` verified while the
asset streams, `.part` renamed to the final file only on a digest match, NSIS `/S` per-user
install on Windows and an AppImage self-replace by rename. DEB and macOS are deliberately manual
(`latest` is reported, `stage` stays `idle`). `isNewer()` lives in `src/shared/types.ts` so main
and renderer compare versions the same way, and the renderer only asks the user to reload the
extension when the extension is *older* than the app. Regressions in `test/update.test.ts` and
`test/renderer-state.test.ts`.

---

## 8. Final end-to-end audit still required

Desired unattended cycle:

```text
real prime finish -> Goal draft -> prime sends -> Workers spawn -> sleep/revive
-> automatic Compact & Resume -> exact prime identity moves -> repeat overnight
```

After TODO #10 and updater:

1. Prove every genuine complete prime answer creates exactly one Goal attempt.
2. Prove manual user Stop creates neither Goal nor automatic reload.
3. Prove explicit page interruption reloads exact chat once.
4. Prove Unattributed recovery waits exactly 20 seconds and does not guess ownership.
5. Prove Goal `[no reply]`/transient failures retry boundedly, while valid stop is terminal.
6. Prove Worker spawn, messaging, sleep, revive delivery, exact liveness, late calls, and slot
   arbitration remain idempotent.
7. Prove pre-send auto-compaction failures may retry, while post-send continuation is exactly once.
8. Prove rebound prime/Worker identity and workspace follow the new chat and retired source chat
   cannot retake the swarm.
9. Prove safety/error UI and partial commentary cannot become a fake finished answer.

Append live facts to `docs/chatgpt-turn-signals.md` without private URLs or IDs.

---

## 9. Shared-tree/tooling gotchas

- Never reset, checkout, clean, reformat, or rewrite shared changes.
- Use `npm.cmd`/`npx.cmd` on this Windows host.
- A piped test command can hide Vitest's exit code. Run it directly.
- Privacy verification has previously failed on two commits already present on `origin/main`
  because of non-noreply author metadata. The user called this pre-existing and out of scope; report
  it rather than rewriting history or bypassing hooks.
- `snapshot/pre-2.0.2-revert-20260830-012347` preserves the pre-reset work.
- `proof/2.0.3-native-matrix` is a behaviour reference only.

## 10. First commands for the next agent

```powershell
git status --short
git diff --stat origin/main
rg -n "recordToolCall|liveConversations|lastSeenAt|setBrowserOpener" src/main
rg -n "tabConversations|conversationForTab|recoverDeferredRevivals" extension/background.js
rg -n "electron-updater|checkForUpdates|quitAndInstall|update" package.json electron-builder.yml src test
```

TODO #10 and the updater are both built. What is open: tunnel Connect/Disconnect latency, and the
live-browser pass over the goal loop and tool calls.
