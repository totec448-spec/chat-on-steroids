# Handoff: browser recovery and the Goal loop

Branch `rebuild/2.0.3-from-2.0.2`, base `73156d6`. Three defects observed live on 2026-08-31
between 01:08 and 01:29, with the session logs that show each one. One is fixed in the working
tree; two are not. There is a fourth item that is a wanted behaviour change, not a defect.

All timestamps below are from `%APPDATA%\chat-on-steroids\sessions\<id>\events.jsonl`. A page
reload is visible there as a change in the *local generation prefix* of `turnId` (`g-<random>-...`),
because that prefix is minted once per page load. That is the only reliable reload signature —
`recoverable` is not persisted on the durable `chat_error` event.

---

## 1. Goal never resumes an answer that a reload recovered — NOT FIXED

The one that still needs doing.

**Evidence.** Prime, session `2026-08-30-6a97d62d`, conversation `6a94b5a4-a070-83ed-9431-455bfe3f3dfc`:

```
01:06:46  turn_start  g-1c59tkocg9su9-0-2
01:08:19  chat_error  "Connection interrupted. Waiting for the complete answer"   turn 8b058c54 (page uuid)
01:12:22  chat_error  "Message delivery timed out. Please try again."             turn 8b058c54 (page uuid)
01:12:28  turn_start  g-vvwtb31ybcx7y-0-1     <- prefix changed: the page reloaded
01:12:30  turn_end    g-vvwtb31ybcx7y-0-1     outcome=unknown
          (nothing further; tool calls ran to 01:24:23, then the chat went idle)
```

The reload worked. The complete answer is on screen and the chat is healthy. But Goal never ran,
and the chat had never reached its goal, so it should have continued.

**Cause.** `extension/content.js:7156`, in `noteGoalTurn`:

```js
if (!GOAL_CONTINUABLE.has(outcome)) return;
```

with `const GOAL_CONTINUABLE = new Set(['completed'])` at `content.js:7106`. The recovered turn is
filed `unknown`, so Goal refuses it.

It is filed `unknown` because a replacement page adopts a generation it never watched begin, and
therefore cannot witness it end. Two existing paths upgrade `unknown` to `completed` when the
ended section has answer text — `content.js:1753` and `content.js:3131` — and neither fired here.
Establish why before changing the gate; the most likely reason is that `ended` was null, because
the adopted turn has no identified page section after the reload, which makes `answerText(ended)`
empty regardless of what is actually rendered.

**Why it matters.** The reload is what saves the chat, and it is exactly what disqualifies the
answer from continuing. Recovery and the Goal loop reach opposite verdicts about the same visible
answer. Any chat rescued by a reload silently drops out of its goal.

**Constraint.** Do not widen `GOAL_CONTINUABLE` to admit `unknown` wholesale. `unknown` also covers
turns nobody ever saw finish, and Goal authoring a user message into one of those is the failure
mode the narrow set exists to prevent. The fix belongs where a recovered answer is classified, not
at the gate that reads the classification.

---

## 2. A chat with no open turn is unreachable by recovery — NOT FIXED

**Evidence.** Same prime session. Its last `turn_end` was 01:12:30; attributed tool calls kept
arriving until 01:24:23 — twelve minutes of real work with no open turn — and then it went silent
with no reload possible.

**Cause.** Two places agree that a chat without an open turn does not exist:

- `src/main/bridge.ts:3853` — `inspectSilentChats` calls `forgetActivity(conversationId)` and skips
  when `!openTurn.get(conversationId)`.
- `src/main/bridge.ts:3909` — `repairCandidates` enumerates `[...activeUntil]`, which the line
  above has already emptied.

So once the ledger entry is dropped, neither a `silence` nor an `unattributed` repair can ever
target that chat again. Only `assistant-error` (needs a recognised error that also named a turn)
and `no-tab` (needs the tab to actually close) still reach it.

This is why nothing reloads a chat whose stream died without a recognised transport error — a
ChatGPT usage limit, for instance. Note the corollary before touching it: a reload cannot fix a
usage cap, so firing there would be noise. The question to settle is whether "no open turn but
still producing attributed tool calls" should keep its ledger entry — not whether every silent chat
should be reloaded.

---

## 3. A repair filed on a broken turn was retired by that turn's own ending — FIXED

**Evidence.** worker-2, session `2026-08-30-b53f0d6c`, conversation `6a94b5d0-d08c-83eb-af59-6b95b33b3fc2`:

```
01:08:45  chat_error  "Connection interrupted..."    turn 53011e26
01:08:55  turn_end    unknown  g-129jwk132imh5-0-2
01:08:55  turn_start  g-1akhw2hmdxi5e-0-1     <- reload fired correctly here
01:13:00  chat_error  "Message delivery timed out"   turn 927efd22
01:13:04  turn_end    failed   g-1akhw2hmdxi5e-0-1
          (no reload; the chat sat on the error card for 15+ minutes)
```

**Cause and fix.** An `assistant-error` repair was filed against the count of turns the chat had
finished, and retired once one more finished. But the failure and the turn's ending arrive in
*separate* observation batches four seconds apart, so the broken turn is still open when the repair
is filed — and the next ending is its own. The repair retired itself before any handout.

`src/main/bridge.ts:3815` now counts the open turn as already spent, so the first ending that means
anything is a turn the chat actually got *through*:

```ts
const live = liveConversations().find((entry) => entry.conversationId === conversationId);
const endedTurns = (live?.endedTurns ?? 0) + (live?.activeTurnId ? 1 : 0);
```

Three companion edits keep the same repair alive against activity that proves nothing about the
lost stream: `noteRecoveryActivity` and `noteCallAttribution` no longer delete an `assistant-error`
repair, and `retireSpentRepairs` covers both turn-scoped reasons. An attributed tool call proves the
request-id join, not the answer stream, and a chat sick enough to need reloading is usually a chat
still calling tools.

Regression test: `test/bridge.test.ts` — *"keeps the reload alive when the turn it was filed about
ends a moment later"*. It fails on the pre-fix line with `expected null`, which is the live symptom.

---

## 4. Wanted: mark any chat active on a recent tool call — NOT IMPLEMENTED

Not a defect report; a behaviour change we want.

**Wanted.** Any agent — prime or worker — reads as `active` while its chat has recorded a tool call
in the last 3 minutes, whatever its lifecycle state says. Item 2's evidence is the case: prime did
twelve minutes of visible work with no open turn and the UI showed nothing.

**Where it must not come from.** `AgentInfo.lastSeenAt` looks like the right field and is not:
`src/shared/session.ts:530` documents that it is stamped both by a proven MCP call *and* by the
agent's own page reporting to the bridge. Any chat with an open tab would read active forever.

**Suggested shape.** The fact does not exist anywhere today, so add it once at the single place that
already folds every event into a summary — `applyToSummary`, `src/main/session/store.ts:743`:

- `SessionSummary.lastToolCallAt: number | null`, set with `Math.max` on `tool_call` (never
  backwards; a call is written once its chat is known, which can be after the turn it ran in ended).
- Construction sites to update: `store.ts:242` (`emptySummary`), `store.ts:1265`, and the checkpoint
  merge at `store.ts:624`.
- `src/renderer/chat.ts:206` then drives the badge off it for every agent, replacing the current
  prime-only special case.

One caveat to solve rather than ignore: this predicate expires on a clock, while the session list
re-renders on IPC pushes. A chat that stops calling tools stops producing pushes, so without a
periodic re-render the badge would stay `active` indefinitely.

The working tree currently holds a narrower prime-only version of this in `src/renderer/chat.ts`
(`primeWorking`, keyed on `summary.updatedAt`). It is a placeholder for the above and should be
replaced, not extended — `updatedAt` moves on any event, not on proven work.

---

## Every change in this working tree

Uncommitted against `73156d6`. `git diff --stat`:

```
 docs/chatgpt-turn-signals.md |  25 ++++-
 extension/chatgpt-dom.js     |  14 ++-
 src/main/bridge.ts           |  46 +++++++--
 src/renderer/chat.ts         |  26 +++++-
 test/bridge.test.ts          | 155 +++++++++++++++++++++++++++++++++
 test/content-script.test.ts  |  46 +++++++-
 test/renderer-layout.test.ts |  14 ++-
 7 files changed, 311 insertions(+), 15 deletions(-)
```

### A. `extension/chatgpt-dom.js` — one line, in `errors()` (~1090)

The root cause of "nothing ever reloads". Every `[role="alert"]` was hardcoded unrecoverable:

```js
-  out.push({ text: value, node, turnId: null, recoverable: false });
+  out.push({ text: value, node, turnId: null, recoverable: transportFailure(value) });
```

A live region names no turn — it is announced above the thread, outside every section — so
`turnId` stays null here and `content.js` places it from the page's own live generation
(`content.js:1962`, `error.turnId || recordedTurn || undefined`). The page therefore already knew
both facts; the adapter was discarding the wording. `transportFailure()` (`chatgpt-dom.js:256`) is
the same classifier the in-turn branch below it already trusted, so this does not invent a new
authority, it stops withholding an existing one from the one shape that can only appear up there:
a send that dies before an assistant turn exists has nowhere else to paint "Message delivery timed
out". An announcement that is not a recognised transport failure is still recorded as session
evidence and still authorizes nothing.

**Verify:** `test/content-script.test.ts` — *"gives a transport failure announced above the thread
the turn it broke"* asserts `failure.recoverable === true` and `failure.turnId === started.turnId`;
*"does not let an unrecognised announcement authorize a reload"* asserts the negative. One existing
assertion was inverted from `recoverable: false` to `true` in the same file, which is the intended
behaviour change and should be read as part of the fix rather than as a weakened test.

**Verified in production**, not only in tests: prime's 01:12:22 → 01:12:28 reload in item 1.

### B. `src/main/bridge.ts` — four scoped edits, all about repair *survival*

1. **`noteRecoveryActivity`** — `assistant-error` joins `unattributed` as exempt from
   activity-driven deletion. Neither reason is about whether the chat is doing something; both are
   retired by `retireSpentRepairs` instead.
2. **`noteCallAttribution`** — the blanket `repairsInFlight.delete(conversationId)` is now scoped:
   it no longer deletes an `assistant-error` repair. An attributed call proves the request-id join
   (the whole of what an `unattributed` repair restores) and proves nothing about a lost answer
   stream.
3. **`retireSpentRepairs`** — covers both turn-scoped reasons, not just `unattributed`.
   `silence` and `no-tab` are about a chat rather than a turn and keep the activity lifecycle.
4. **`noteRecoveryObservations`** — files the repair against the turn count the chat *will* have
   once the broken turn ends (item 3 above). This is the edit that the live worker-2 trace proves
   necessary, and the one most likely to look redundant on a first read: without it the other three
   still lose the repair, four seconds later, to the broken turn's own `turn_end`.

The role-fence comment was also rewritten to state the two-source rule explicitly: only the DOM
adapter's classifier may set `recoverable`, and only the page's live generation may name the turn.

**Verify:** four tests in `test/bridge.test.ts`, under `describe('unattributed activity recovery')`:

| test | proves |
| --- | --- |
| *reloads a chat parked on a transport failure the banner could not name itself* | edit A end-to-end through the bridge |
| *keeps a broken turn's reload alive while that turn goes on calling tools* | edit 1 + 2 |
| *keeps the reload alive when the turn it was filed about ends a moment later* | edit 4 |
| *hands the repair out after the cooldown, however busy the chat was while it waited* | the held-repair case: a `no-tab` reload spends the cooldown, then a `chat_error`, then six attributed calls at 15s intervals |

Each was checked to **fail before the fix and pass after**, not merely to pass. Edit 4's test fails
pre-fix with `expected null to be '<conversation>'` — no repair handed out, which is exactly the
live symptom.

### C. `src/renderer/chat.ts` — `primeWorking` / `PRIME_WORKING_MS`

The placeholder described in item 4. `chat.ts:206` gated Prime's badge on `summary.activeTurnId`;
it now uses `primeWorking(summary)`, which also accepts a chat whose summary recorded anything in
the last three minutes. No new IPC: `applyToSummary` (`store.ts:749`) already advances
`summary.updatedAt` on every event including `tool_call`, which was confirmed against live data —
prime's `meta.json` `updatedAt` was 01:24:24, matching its last `tool_call` at 01:24:23 to the
second.

**This is the change to replace rather than build on.** `updatedAt` moves on any event; item 4
wants proven work, and wants it for workers too.

**Verify:** `test/renderer-layout.test.ts` — the existing source-regex test *"does not call an idle
prime active merely because it still owns the run"* was updated to match `primeWorking(summary)`,
and *"still calls prime active while its chat is recording tool calls without an open turn"* was
added.

### D. `docs/chatgpt-turn-signals.md`

Recovery contract updated: a fifth recognised shape (a visible `role="alert"` live region) with a
paragraph on why it is not a lesser case of the in-turn shape; a corrected "more than one tab"
bullet that had gone stale; and a paragraph stating that repair retirement is scoped to the
evidence a repair was filed on.

### Suite state

`npx vitest run` — **1917 passed, 18 skipped, 70 files**. `npx tsc --noEmit -p tsconfig.json`
clean. One unrelated flake exists in the suite and is not caused by these changes: *"starts Goal
when the only hidden-tab terminal mutation is the Stop control outside the transcript"* can fail
with `scans` 0 under full-suite load and passes in isolation.

---

## Appendix: what the live runs actually looked like

Three ChatGPT chats driven by the app (prime plus three workers), 2026-08-31, roughly 00:58–01:29.
The user watched all four in the browser while the session logs were read from disk.

**The reported symptom, for months:** chats park on a visible ChatGPT error card and never come
back. The user had never once observed a reload fire — only a tab being *reopened* after being
closed, which is the separate `no-tab` path. That distinction is what made this hard to see: the
recovery machinery visibly worked, on the one path nobody needed.

**Run 1 — prime, the case that proves A works.** At 01:08:19 the page announced "Connection
interrupted. Waiting for the complete answer", then at 01:12:22 "Message delivery timed out. Please
try again." — the second rendered as a top-level live region, above the thread, with no assistant
turn to belong to. Six seconds later the local generation prefix changed from `g-1c59tkocg9su9` to
`g-vvwtb31ybcx7y`: the page reloaded, and the complete answer came back. Before fix A the app
recorded both errors, marked the turn failed, and did nothing at all.

**Run 2 — worker-2, the case that proves B is needed.** Identical wording, opposite outcome. Its
01:08:45 failure did reload (01:08:55, prefix `g-129jwk132imh5` → `g-1akhw2hmdxi5e`). Its 01:13:00
failure did not, and the chat sat on a "Message delivery timed out. Please try again." card with a
Retry button for over fifteen minutes while the model behind the dead stream went on calling tools
every ten to thirty seconds. The cooldown was *not* the cause — the 01:08:55 reload's three-minute
floor had expired at 01:11:55, well before 01:13:00. The repair was filed and then destroyed, twice
over: by the attributed tool calls, and by the broken turn's own `turn_end` at 01:13:04.

Worth stating plainly, because it inverts the intuition: **a chat sick enough to need reloading is
usually a chat still calling tools.** Server-side generation survives a lost browser stream. Every
piece of "the chat is fine, it is doing things" evidence is produced most reliably by exactly the
chats that are broken. Any future retirement rule has to be about the *turn the repair was filed
on*, never about whether the conversation looks busy.

**Run 3 — why run 1 succeeded at all.** Luck. Prime happened to have a 36-second gap with no tool
calls (01:12:04 → 01:12:40) straddling its failure, so no attributed call arrived to delete the
repair before the browser's next `/status` poll collected it. Fix 4 removes the luck.

**Run 4 — prime after recovery, items 1 and 2.** The reload at 01:12:28 saved the answer, but the
recovered turn was filed `outcome=unknown` and Goal refused it (item 1). Prime then ran tool calls
until 01:24:23 with no open turn — invisible in the UI (item 4) and unreachable by recovery
(item 2) — and stopped. A user watching the app saw an idle-looking chat that was working, and then
a working-looking chat that had stopped, with no reload possible in either state.
