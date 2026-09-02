# Handoff: turn-lifecycle invariants (2026-08-31)

Branch `rebuild/2.0.3-from-2.0.2`. Written for a review agent: check whether the behaviour the
maintainer asked for is actually implemented, and re-run the live tests. The live repro at the
end **reproduced the original bug again** — that is the most important open item.

---

## 1. What was asked for

### 1.1 Reported symptoms

- **User messages sorted behind the answer.** User bubbles rendered *after* the reply they
  triggered ("also the falsly injected user messages after the answer to them").
- **Phantom turn split.** A turn transcribed as ended + restarted with no semantic reason —
  in `events.jsonl` a `turn_end unknown` and a `turn_start` at the **identical millisecond**.
- **`CHATGPT (PARTIAL)` instead of final.** A finished answer stayed PARTIAL and the app wrote
  "last turn ended for an unknown reason" while the turn was visibly complete.
- **Late self-correction.** "it switched like 5 minutes after finishig from partial to final" —
  the repair arrived, far too late and through the wrong path.
- **A wrongly parsed final answer** inside an otherwise correctly transcribed turn.

### 1.2 The invariants the maintainer set

1. **Browser lifecycle (reload / close / navigation) must NEVER by itself produce a semantic
   `turn_finished`.** A turn finishes only on real evidence. A tab close must not clear the
   recovery eligibility. Tab lifetime owns the *binding* — which tab speaks for this
   conversation — and nothing else.
2. **A semantic turn opens ONLY** on a genuinely newly authored user message (stable id absent
   from `userAnchorByMessage`), or it **adopts** a durable `activeTurnId`. Nothing else opens
   one. Stop / retry / Fiber / Copy may not mint a turn. "Stop" may only describe the liveness
   or quietness of an **already open** turn.
3. **Engine model:** MCP calls are never a final end. Agents end with a `finish` call, Prime
   with a final message. If neither arrives and two minutes pass with no interim/MCP activity →
   reload. New interim/MCP activity restores active and makes a second reload eligible. Closing
   Prime reopens it automatically.
4. **The Goal obligation** for the exact turn + final reply must survive reload/restart and stay
   pending until durable Text or NO_REPLY is acknowledged. Transport/provider failure and TTL
   must **not** consume it.
5. **Route A → B** must not be solved with a global "the app has anchors" flag. On adopting a
   concrete B, immediately bind/pull B's activity, then re-run the one normal `observe()` after
   that authority arrives; until then do not consume B's transcript. No pending-user side state.
6. **Delete Copy/`completionAction` success authority** rather than compensating for a missing
   `end_turn`: an exact Fiber final is success, otherwise the turn stays open for recovery.

### 1.3 Working rules

- Live-test the real site first, record raw signals + transcription, then derive the invariant
  and root cause, then make a minimal fix. No new timers or fallbacks.
- Fix the underlying engine, do not build over it. No fallback stacks, no heuristic layers.
  Quality over quantity, small diff, delete superseded logic and comments.
- Judge failing tests against the *new* invariant instead of preserving obsolete expectations
  (the retry test that expected a second `turn_start` was itself wrong).
- Public repo: no provenance URLs or session trailers in commits, files, logs or artifacts;
  maintainer commits use a GitHub noreply address; run `npm run verify:privacy` before every
  commit/push/tag/release; never bypass with `--no-verify`.
- `npm run verify` must run in PowerShell — it dies in Git Bash on its ripgrep/tar step.
- The working tree is shared: never `reset`, `checkout`, `clean` or reformat.

---

## 2. What changed

### 2.1 `extension/fiber.js` — channel-aware turn end

Three helpers before `hiddenMessage()`: `channelOf()`, `analysisMessage()`,
`neverTerminalChannel()`.

- `authoredAssistantMessages()` skips `analysis`.
- The tail scan in `turnEndMessageId()` skips `analysis` **and** `commentary` before testing
  `end_turn === true && status === 'finished_successfully'`.

Reason: ChatGPT appends analysis/commentary ghosts after the real final answer. `end_turn` is a
**top-level** message field, not inside `metadata`.

Regressions in `test/fiber.test.ts` (3 new): trailing analysis ghost, trailing commentary ghost,
and the preserved retry case where a newer answer-capable message keeps the turn open. Messages
with no `channel` at all stay compatible. **47/47 green.**

### 2.2 `extension/content.js`

- **Overwrite root fix:** `ownerClaims` is seeded with the live local turn id unconditionally.
  Previously the seed was conditional on a resolvable `ownedPageTurn`; when that was -1 the seed
  was skipped and a historical section claimed the live generation through a reused request id.
- `reportMessages()` returns `null` while `resumeIdentityPending` — the transcript is not read at
  all, rather than read and declined. Consuming a message marks it seen forever, which spent the
  one send that really had just happened.
- `authoredNow` lost its `!resumeIdentityPending` clause.
- On the SPA move: `void pullActivity()` immediately after `resetConversation()` (invariant 5).
- `rememberResumeGoalPending()` binds an already-open generation.
- **Deleted:** `fiberQuietTerminal()`, `completionActionBaselineSections`,
  `baselineCompletionSections`, `corroboratedTerminalMessageId` / `corroboratedTerminalBoundary`
  (invariant 6). `grep -c "completionAction\|fiberQuietTerminal\|corroboratedTerminal"` → 0.
- **New:** on a transport failure `requestGoalDraft()` releases its `goalTurnId` claim. The app
  never heard the question, so the turn is still owed an answer and
  `maybeRecoverDurableGoalTurn()` may pick the durable pending row up again — previously a single
  dropped message parked the obligation until the next reload.

`test/content-script.test.ts` **290/290 green.**

### 2.3 `src/main/session/recorder.ts` — invariant 1

`closeConversation()` no longer appends `turn_end unknown`. It appends a non-semantic `note`
event instead (carrying the `turnId` for grouping). The open turn stays open; `resumeHistory`
rebuilds it from the journal, and `endSession()`/`reopenSession()` are only UI liveness. Docblock
rewritten.

Regression in `test/session.test.ts`: *"keeps the open turn open when the ChatGPT page detaches
mid-turn"* — no `turn_end`, exactly one `note`, the same `sessionId` on reopen, and the later
real `turn_end completed` is the only end. **109/109 green.**

### 2.4 `src/main/bridge.ts` — invariant 3 (the two-minute ledger)

- `activeUntil` is now `Map<string, number>` (a deadline). `interface ActivityGrant` and
  `recoverWithoutOpenTurn` are **deleted**.
- **Armed by the opening `user_message` and `turn_start`** — that was the hole. The ledger used to arm only on an interim
  update or an attributed call, so a turn that opened and then went entirely quiet, the exact
  failure this watch exists for, was the one turn nobody watched. An interim assistant update
  still arms it too (after a reload that may be all a resumed generation ever produces), and an
  attributed MCP call still arms/bumps.
- Any other meaningful activity only pushes an **already** armed deadline forward.
- **Terminal** is now any `turn_end` with `outcome !== 'unknown'` (was only `stopped`) or a
  stable final assistant. `unknown` is the page saying it does not know, which keeps the
  obligation alive rather than discharging it.
- `inspectSilentChats()`: the `openTurn` cross-check and the `forgetActivity` /
  `repairsInFlight` pruning hanging off it are **deleted** — the turn that armed the deadline
  outlives the page that reported it.
- `repairCandidates()` adjusted to the new map shape.
- **`workerFinalAcrossBatches()`:** a stable final assistant message alone is now the terminal;
  `turn_end` is used only for ordering and is no longer required. A page that detaches or
  reloads right after the answer settles never writes one, and the worker stayed a zombie
  holding its slot.

Regressions in `test/bridge.test.ts` (4 new): a turn with no interim update or tool call at all
is watched; the watch survives a detach before the window runs out; `unknown` does not end it
while `completed` does; a worker is retired on its final answer with no `turn_end`.
**170/170 green.**

### 2.5 `src/main/goal.ts` — invariant 4 (Goal durability)

- `expireDraftPayload()` no longer calls `handleGoalReply()`. The ten-minute TTL is for the
  *payload*, not the *obligation*: a clock running out is not an answer.
- `ackGoalDraft()` discharges the obligation only on `stage === 'ready'` or `'no-reply'`. A
  dropped stream, a rejected key, an exhausted balance, an abort — all of them are the app
  failing to produce an answer, and a failure to answer may not be recorded as an answer.
- `spentFailure` in `startGoalDraft()` is kept (a settings failure is not silently paid for
  again), but documented: the obligation behind it survives regardless.

Regressions in `test/goal.test.ts` (4 new): still pending after a retryable failure; still
pending after a settings failure; still pending past the ten-minute TTL; discharged **only**
after acknowledging a `ready` draft. **72/72 green.**

### 2.6 Deliberately not changed

- `GOAL_REPLY_TTL_MS` (12 h) stays as a safety bound — typing into a chat somebody left a day
  ago is the failure this subsystem exists to prevent. It is an upper bound, not an
  "expiry means completed" path. Flag it if the maintainer wants it gone too.
- `retireGoalDrafts()` / `retireGoalDraftsFor()` still mark replies `handled` — that is explicit
  revocation by the user (Goal turned off, objective replaced), not a failure.
- `test/mcp.test.ts > "keeps the worst-case no-query discovery of each surface small"`
  (`exec_command schema is 3572 bytes: expected 3572 to be less than 3500`) — a pre-existing,
  separately documented regression, explicitly out of scope. Proven pre-existing by stashing the
  diff and re-running.

### 2.7 Test state

`npm run typecheck` clean. Full suite: **1942 passed, 18 skipped, 1 failed** — the one failure is
the pre-existing MCP discovery-budget regression above.

### 2.8 Install

`npm run build`, `npm run dist:win`, then `Chat-On-Steroids-Setup-x64.exe /S`; app restarted. The
extension ships inside the installed build at
`%LOCALAPPDATA%\Programs\Chat On Steroids\resources\extension` and contains the new code
(verified: `neverTerminalChannel` and the new Goal claim release are present in those files).

---

## 3. Live repro, 2026-08-31 — and what it found

**Setup:** fresh tab → `chatgpt.com` → new chat → a web-search + 900-word prompt ("Search the web
for the current state of QUIC congestion control … BBRv3 … CUBIC"). ChatGPT produced the safety /
interim stream *"Our systems are thinking a bit more about this request before responding."*
Mid-flight I sent a user follow-up ("actually stop that and just answer in one sentence
instead"). A MAIN-world probe recorded the Fiber replies.

Session `2026-08-31-f1bf443f`, conversation `6a957ccb-6d80-83ed-916c-b126ee837fdd`.

### 3.1 What the app journalled (`events.jsonl`)

```
seq  time            kind         turnId                  outcome
1    13:08:44.203    session_start
3    13:08:43.206    turn_start   g-19cy1gd7xwyby-0-1
6    13:10:09.187    turn_end     g-19cy1gd7xwyby-0-1     unknown
7    13:10:09.187    turn_start   g-19cy1gd7xwyby-0-2
11   13:10:23.211    page_tool    g-19cy1gd7xwyby-0-2
17   13:10:42.974    turn_end     g-19cy1gd7xwyby-0-2     completed
20   13:11:00.264    turn_start   g-19cy1gd7xwyby-0-3
23   13:11:06.204    turn_end     g-19cy1gd7xwyby-0-3     completed
```

Message shards (`messages/*.json`):

```
seq origin kind               turnId               state      final
4    2     user_message       —                                     "Search the web for the current state of QUIC…"
8    5     user_message       —                                     "actually stop that and just answer in one sentence instead"
13   9     assistant_message  g-19cy1gd7xwyby-0-2  streaming  false
14   10    assistant_message  g-19cy1gd7xwyby-0-2  streaming  false
21   19    user_message       —                                     "you havent answered yet. just give me the one-sentence version"
22   15    assistant_message  g-19cy1gd7xwyby-0-2  final      true
24   24    assistant_message  —  (no turnId!)      final      true
```

### 3.2 Three findings — the original bug is still live

**A. The phantom split is not gone.** `turn_end g-…-0-1 unknown` and `turn_start g-…-0-2` sit on
**exactly the same millisecond**, 13:10:09.187. No tab was closed, nothing reloaded — so this is
*not* `closeConversation()`. The trigger was the safety / interim stream. Invariant 1 is
therefore still violated somewhere in `extension/content.js` that has not been found yet.
**This is the most important open item.**

**B. A final assistant message with no `turnId` at all.** seq 24 (`origin=24`, i.e. first seen at
delivery time) is `final: true` and bound to no turn. That is exactly the shape that surfaces in
the UI as "CHATGPT (PARTIAL)" or as a wrongly placed final answer.

**C. Fiber reported `endMessageId: null` throughout.** Across the whole episode, including after
`generating` went false, no turn ever carried an `endMessageId` in the probe. Either the probe
sampled before the final settled, or the new tail scan in `turnEndMessageId()` is skipping the
real final. These two must be told apart.

**Side finding:** the third user message (seq 21, "you havent answered yet…") was not typed by a
human — Goal Mode wrote it into the chat 17 s after `turn_end completed` for `-0-2`. Whether that
is correct Goal behaviour here or a misfire after the phantom split is open.

### 3.3 Important caveat

**The Chrome extension could not be reloaded.** `chrome://extensions` is not reachable from
browser automation. The files on disk are new, and Chrome does read content scripts for unpacked
extensions from disk at injection time, but the registered service worker (`background.js`) may
still be the old one. **The whole repro above must be repeated after a real extension reload**
before finding A is treated as "the fix did not work".

---

## 4. What to verify

### 4.1 Code review against the invariants

1. Find the path in `extension/content.js` that closes and immediately reopens the turn during a
   safety / interim stream (finding A). Per invariant 2 a `turn_start` may only come from a newly
   authored user message or an adoption. Check specifically whether `generating` /
   `CLF_DOM.generating()` flickers when ChatGPT shows the safety notice, and whether that flicker
   reaches `finishGeneration()`.
2. Work out how an `assistant_message final: true` can be produced with **no** `turnId`
   (finding B), and where `chronological()` / `streamTurnGroups()` can then place it.
3. Confirm no path synthesises `turn_end` from browser lifecycle any more:
   `grep -rn "outcome: 'unknown'" src/ extension/`.
4. Confirm Copy/`completionAction` is fully gone:
   `grep -rn "completionAction\|fiberQuietTerminal\|corroboratedTerminal" src/ extension/` → 0.
5. Check that deleting `recoverWithoutOpenTurn` left no hole: can a chat with no open turn stay
   in `activeUntil` and request reloads repeatedly? (`finishSilentChats` → `forgetActivity` is
   the only retire path; a grant whose repair is never confirmed should rest after exactly one
   reload.)
6. Decide whether `GOAL_REPLY_TTL_MS` (12 h) is acceptable as a safety bound or whether the
   maintainer wants it removed as well — it was kept deliberately.

### 4.2 Live tests (after a real extension reload)

First: `chrome://extensions` → reload the extension. Then read
`%APPDATA%\chat-on-steroids\sessions\<id>\events.jsonl` and `messages\*.json` after each test.

| # | Scenario | Expected |
|---|---|---|
| 1 | **Safety/interruption (the repro above)** — fresh chat, web-search prompt, wait for the safety notice, send a user follow-up mid-flight | Exactly as many `turn_start`s as real user sends. **No** `turn_end unknown`. No `turn_end`+`turn_start` on the same millisecond. Every final answer carries a `turnId`. Nothing stays PARTIAL. |
| 2 | **Tab close mid-turn** — start a long turn, close the tab, reopen the chat | No `turn_end unknown` on close; exactly one `note` event instead. The "active" label survives. The turn stays open and is closed `completed` by the real later answer. |
| 3 | **Reload mid-turn** — F5 during generation | No split. The turn is adopted, not reopened. The answer lands in one turn. |
| 4 | **Two-minute silence** — open a turn that goes quiet (e.g. drop the network) | Exactly one reload after 2 min, no more. New interim/MCP activity afterwards makes a second reload eligible. A `turn_end unknown` does not cancel the watch; `completed`/`stopped` does. |
| 5 | **Worker without `finish`** — spawn a worker, let it answer normally without a `finish` call | Worker goes `sleeping` with its result and releases its slot. No zombie. |
| 6 | **Goal + broken key** — Goal Mode on, invalidate the OpenRouter key, let a turn finish | The draft fails, the obligation stays **pending**. Fix the key → that same turn still gets its reply. |
| 7 | **Goal + orphaned ready draft** — let a draft reach `ready`, close the tab, wait >10 min | Obligation still pending, and the **same token** comes back (no double send). |
| 8 | **Tool-heavy turn with a burst release** — many tool calls whose output ChatGPT releases in one burst | Assistant prose is not stamped with a later generation. User bubbles do not render behind the final answer. |
| 9 | **Close Prime** | Reopened automatically. |

### 4.3 Diagnostics used

MAIN-world Fiber probe (paste into the ChatGPT page, then read `window.__clfProbe.log`):

```js
(() => {
  if (window.__clfProbe) window.__clfProbe.stop();
  const log = []; const t0 = Date.now(); let n = 0; const seen = new Map();
  const onReply = (event) => {
    const d = event.data;
    if (!d || d.source !== 'clf-fiber-reply' || !String(d.nonce || '').startsWith('probe-')) return;
    const at = Math.round((Date.now() - t0) / 1000);
    for (const turn of (d.turns || [])) {
      const st = JSON.stringify({ endMessageId: turn.endMessageId ?? null, calls: (turn.calls||[]).length, acts: (turn.activities||[]).length });
      if (seen.get('T:' + turn.turnId) !== st) { seen.set('T:' + turn.turnId, st); log.push({ at, turn: turn.turnId, ...JSON.parse(st) }); }
      for (const m of (turn.messages || [])) {
        const s = JSON.stringify({ role: m.role ?? null, stable: m.stable ?? null, order: m.order ?? null, len: (m.rawText || '').length });
        if (seen.get('M:' + m.messageId) === s) continue;
        seen.set('M:' + m.messageId, s);
        log.push({ at, msg: m.messageId, ...JSON.parse(s) });
      }
    }
  };
  window.addEventListener('message', onReply);
  const timer = setInterval(() => window.postMessage({ source: 'clf-fiber-ask', nonce: 'probe-' + (++n) }, location.origin), 900);
  window.__clfProbe = { log, stop() { clearInterval(timer); window.removeEventListener('message', onReply); } };
  return 'probe armed';
})()
```

Reading a journal:

```bash
node -e "for(const l of require('fs').readFileSync(process.argv[1],'utf8').trim().split(/\r?\n/)){const e=JSON.parse(l);console.log(e.seq,new Date(e.time).toISOString().slice(11,23),e.kind,e.turnId||'',e.outcome||'')}" \
  "$APPDATA/chat-on-steroids/sessions/<id>/events.jsonl"
```

---

## 5. Bottom line

The three invariants from the last round — tab close, the two-minute ledger, Goal durability —
are implemented, regression-covered and typecheck-clean, plus the worker-final-without-`finish`
fix. **But** the fresh live repro shows the originally reported bug still occurring: a
`turn_end unknown` and a `turn_start` on the same millisecond plus a final assistant with no
`turnId`, triggered by the safety/interim stream with no browser lifecycle event involved. That
is not fixed. Reload the extension for real, repeat the repro, then find the triggering path in
`extension/content.js`.

---

## 6. Follow-up audit and repair (later 2026-08-31)

The live-repro interpretation in §3.2A was too broad. The journal contains three real user
messages and three `turn_start` events. In particular, the first same-millisecond
`turn_end`/`turn_start` happened when the user genuinely authored the mid-flight follow-up
"actually stop that...". One authored user message is the semantic boundary that atomically
ends the unfinished request and opens its replacement, so equal timestamps do not themselves
prove a phantom split. Artificially delaying one event would only make the journal less exact.

There were still two real lifecycle defects in that evidence:

1. The replaced unfinished turn was labelled `unknown`, even though the new authored user
   message is direct interruption evidence. `content.js` now records that boundary as
   `interrupted` with detail `a new user message replaced the unfinished turn`. It still opens
   exactly one replacement turn; Stop/Fiber/Copy still mint none.
2. `refreshFiber()` crossed an async boundary and then read the mutable current
   `generating`/`turnId`. If turn A's scan returned after user turn B opened, the final from A
   could be re-read against B and queued as `turnId: undefined`. The scan now captures A's exact
   page node and durable local id before awaiting Fiber, validates a moved claim against the
   settled node/signature tombstone, and retains the strongest non-conflicting owner for each
   stable assistant message. A concurrent unowned scan can no longer downgrade an exact owner;
   contradictory positive owners fail closed.

The remaining `completionAction` selector/helper/export in `chatgpt-dom.js` was also deleted.
It was dead, but its presence contradicted invariant 6 and the earlier claim that Copy success
authority had been fully removed.

Regression proof was added to `test/content-script.test.ts` for an in-flight Fiber scan whose
turn is replaced before the response arrives, plus the two existing follow-up-boundary tests now
require `interrupted`. The regression produced a stable final with `turnId: undefined` before
the repair and passes afterwards. Focused browser-extension gates after the repair:

- `test/content-script.test.ts`, `test/fiber.test.ts`, `test/extension.test.ts`: 423 passed.
- `npm.cmd run typecheck`: passed.

That statement described the evidence boundary at the time of this earlier audit. The extension
was subsequently reloaded by the user and §7 records the installed live-browser verification that
followed; the source/test result above should still not be mistaken for that later proof.

---

## 7. Fresh-chat attribution regression and repair (later 2026-08-31)

Live session `2026-08-31-fe6b615b` proved a separate regression. Its opening user message and
`session_start` were durable at 17:13, while all six MCP calls carrying request id
`ff1c6588-1095-4e4b-be65-91105d6b087f` stayed Unattributed until a second reload repaired them.
The request id therefore reached MCP ingress; the immediate browser join did not.

The earliest wrong transition was duplicate ownership of a visible user message. During the SPA
identity gate, `pullActivity()` refreshed Fiber before the normal DOM pass. Fiber published the
same stable user row and marked it seen; when the gate opened, the DOM recorder could no longer
use that message id as the exact send receipt that emits `turn_start`. With no local turn owner,
the fresh chat's provisional Fiber conversation id was correctly rejected and its request id was
never paired to the real route. Reload recovery could repair the history later but could not
restore timely worker liveness.

The repair removes that competition: a user message whose stable id is rendered belongs to the
DOM recorder, which records it and opens the turn in one synchronous observation. Fiber retains
only its narrow backfill role for page-model user messages whose id is not yet exposed in the DOM.
No timer, guessed tab, or retry path was added. A deterministic regression now forces Fiber to see
the same rendered user row first and requires exactly one user message plus one `turn_start`.

The just-authored opening `user_message` also arms the bridge's activity ledger for the requested full two
minutes, before `turn_start` or an attributed call has to arrive. The renderer derives the same
two-minute Active label from `SessionSummary.startedAt` or the latest exact tool call, bounded by
a later stable final answer. Focused proof: content-script, bridge, and renderer-layout suites,
497 tests passed.

The rebuilt x64 package was installed and the installed `app.asar` exactly matched the packaged
payload (SHA-256 `C006BBA93BB1E7FCB5DF386FE15AD4B9762B722A6000D0B0028D4CD332F9276`). After the
user reloaded the extension and restarted the tunnel, a new Chrome chat sent one real prompt with
no reload while generating. Conversation `6a959f65-31b8-83eb-ae94-591a28473e5c` was immediately
recorded as session `2026-08-31-b70aa065`; its `user_message` and `turn_start` share local turn
`g-51uc2upfio9g-0-1`, and all three resulting Core calls were stored in that session with
`attribution: request_id`. Correlation state immediately joined request id
`6dca77cd-a1a3-45d5-96f4-aa34e7312220` to that exact conversation and session. No call entered
Unattributed and no reload was needed to repair it.

Final gates for this installed payload: 71 test files passed, 1,950 tests passed and 18 skipped;
typecheck, build, and x64 packaging passed. `verify:privacy` remains blocked only by the existing
non-noreply author metadata in commits `9e27c0fafc20bf2c81509844d5f92868678b4168` and
`03acfbaad9d753d09487761e97cc1eade8eb8b22`; no history was rewritten as part of this repair.

### 7.1 Recovery-reload loop found by installed live use

The first implementation incorrectly treated `stored > 0` as proof that every meaningful-looking
row in one `/events` batch was new. A replacement document routinely sends an accepted title beside
the already-recorded opening user row. The title made `stored` positive; the raw historical user row
then re-armed `activeUntil` even after a stable final had spent it. Every confirmed reload replayed
the same shape and scheduled the next reload, producing the observed alternating 17:41–17:54 loop
for `Read package name` and `Read Android Codebase`.

The recorder now returns the activity effect of only the individual observations it actually
accepted. A DOM user row can open the narrow pre-`turn_start` window only when `content.js` marks it
`authoredNow`; reload/history rows never carry that proof. Current assistant revisions reuse the
page's existing `liveAssistant` verdict as `activeNow`, so a genuinely continuing id-less response
renews the window while historical Fiber backfill cannot. Accepted turn starts, `activeNow` interim
output and exact attributed MCP calls renew the shared two-minute window; current stable finals and
real turn ends spend it. The native Active badge and bridge import the same duration constant. The existing
Unattributed path remains separate: twenty seconds of request-correlation grace, then a one-minute incident window
that excludes chats proving their join with an attributed call.

Final installed proof used packaged/installed `app.asar` SHA-256
`B85259B2BCD201E9E51B2E52126B7EA1715CD28A6BD0C4BB1CFA7176FA3606E9`. The reloaded extension
connected at 18:13:37 and both tunnels at 18:14:03. The native Activity log was read again after
18:16, beyond a complete two-minute window, and contained no silence recovery at all. Chrome then
contained only its ordinary `https://chatgpt.com/` tab; neither historical conversation reopened.
Final gates: typecheck passed; 71 test files passed with 1,952 tests passed and 18 skipped; x64
packaging and silent install passed with an exact packaged/installed hash match.
