# Final release QA — macOS, 2026-09-04

The last gate before this branch is release-ready. Two things stand in the way: one open defect
that three sessions have failed to isolate, and the QA steps that have never run on any build.

Everything here is written for Mac Claude Code. Standing authorization to fix and push applies:
root cause first, smallest correct fix, a regression test confirmed failing without it, tsc and
the full suite green before every commit, no Claude attribution.

## Setup

`git pull` on `integrate/browser-and-desktop-064733` → `71d0c48` or later. Install the packaged
artifact from the newest green *Release candidate* run rather than dev mode: this is the final
pass, and it should measure the thing that ships.

## Part 1 — the open defect, answered on Windows; confirm it on yours

**Run this first — it is now one command.**

    npm run verify:compact-chain

It launches its own Chrome, loads `extension/` unpacked, and drives all seven compact
checkpoints from inside the content script's own isolated world, through the real service worker,
to the real app. That is the join no unit test can see and the one no session had reached: the
bug was never in `content.js`, `background.js` or `bridge.ts` alone, only in the seams.

**On Windows, against this build, all seven reach their own branch** — `sourceLost` and
`destinationLost` included, the latter working for the first time since it was written. The app
logged no fall-through, and the worker under test was confirmed to be the file on disk by the
digest. So the chain drops nothing on this code, and the give-up you saw answered from the
start-compaction branch does not reproduce against it.

**Which leaves one likely explanation, and the tool found it by accident.** The first version of
that script reused a single Chrome profile, and it *certified a build with `destinationLost`
deliberately deleted* — every check passed, because Chrome served the extension already
registered in that profile rather than re-reading the folder. The manifest bump forces a reload;
it does not guarantee Chrome re-reads every file, and nothing in the app's log distinguishes the
two. That is a stale-code path that survives a version bump, which is exactly the shape of what
you measured.

So: run the command, and compare the digest it prints with the app's connect line. If they agree
and all seven pass, the defect was environmental on the earlier run and Part 1 is closed. If
`sourceLost` fails there with `session_not_recorded`, you have reproduced it against a known-good
tool and the next step is which of the three files the loaded extension actually differs in.

### Background, if the run above does not settle it

**What is broken.** A page reports `sourceLost` when `send()` proves ChatGPT never took an armed
handoff. The app is meant to end the transaction. It does not: the continuation stays in
`dispatched-unresolved` until its six-hour TTL, and the chat loses browser recovery for that
whole window because `inspectSilentChats()` skips anything `pendingAutomaticContinuations()`
still names.

**What has been ruled out, so do not re-derive it.**

- The app's branch is live and correct — a direct `POST /compact` with
  `{conversationId, token, sourceLost:true}` returns `{"released":true}` and aborts the entry.
- The page genuinely calls it, with a token in scope: the same `token` binding that
  `sourceDispatch` uses eleven lines earlier, and that one demonstrably reaches the app.
- The worker's forwarding list contains `sourceLost`, and a test drives every entry in it.
- Ordering in `/compact` is fine: `sourceLost` precedes `cancel`, `ticket` and the default.
- The stale-worker theory is dead by your own manifest-bump evidence.
- There is no third whitelist: `ask()` spreads, `sendToWorker` passes through, the dispatcher
  hands the message to the handler whole.

**The one datum still missing** is what keys the give-up's POST actually carries. Two new things
make that a log read rather than a session:

1. `bridge: /compact start request — body keys: …` now logs on **every** start-shaped request,
   unconditionally. `sourceAttempt` and `sourceDispatch` reach the same route with their token
   intact on every compaction, so their key lists sit in the same log as the give-up's. **The
   diff between them is the answer.**
2. `bridge: browser extension <version> connected (build <digest>)` now reports six bytes of
   SHA-256 over the running `background.js`. Compare it to the repo:

       shasum -a 256 extension/background.js | cut -c1-12

   Equal means the worker running is the file on disk. Unequal means it is not, and that alone
   explains the whole defect — the earlier ternary-based worker drops a `sourceLost` message
   exactly this way, losing both token and flag and leaving the app to answer from its
   start-compaction branch, which is precisely what you measured.

   Both halves of this were verified live on Windows against real Chrome before it shipped, not
   only in the harness: the extension was loaded over the CDP pipe, driven to chatgpt.com, and
   the app logged

       bridge: browser extension 2.0.5 connected (build 174e00e33b5b)

   against a `shasum` of the same file reading `174e00e33b5b`. So a mismatch on your machine is
   evidence about your machine, not about the mechanism.

   One trap worth knowing, because it cost a false negative here first: the app holds a
   single-instance lock, so a `npm run dev` started while an older app is still running exits
   immediately and leaves the *old* build serving port 8765 — which logs no digest at all and
   looks exactly like the feature not working. If the connect line has no `(build …)` on it,
   check for a stale instance before concluding anything.

   **Do not try to identify the worker by reading its variables.** An earlier version of this
   brief said to evaluate `COMPACT_CHECKPOINT_FLAGS` in the service worker console and treat
   `undefined` as proof of a stale worker. That instruction was wrong and would have produced a
   confident false positive: `background.js` is an ES module, so none of its top-level bindings
   reach `globalThis`, and the name is `undefined` on a perfectly current worker. Measured over
   CDP against the real extension — `1+1` evaluates to `2` and `typeof chrome` is `"object"` in
   the same session where `typeof COMPACT_CHECKPOINT_FLAGS` is `"undefined"`. The digest above
   is the mechanism precisely because it does not depend on scope.

**The run.** Install, confirm the build digest matches, force a send failure, read the log.
Report the two key lists verbatim. If the digest does *not* match, that is the finding — say so
and stop; the fix is a packaging or load-path question, not a code one.

If the keys show the field arriving and the app still not acting, that contradicts a passing
test and I want the raw log rather than a fix.

## Part 2 — never run on any build

Neither has ever been executed. Both are cheap and both are release-blocking in the sense that
nobody knows the answer.

- **`destinationLost`.** Written 2026-09-02, correct at both ends, and never once reached the app
  until `350c337` — so it has never been seen working. Drive a real Compact & Resume until chat B
  holds the brief in its composer, then clear the composer before the click lands. Confirm the
  page reports it, the app releases the armed dispatch, and the brief is offered to a fresh chat
  rather than sitting armed for the quarter-hour lease. If it cannot be triggered by hand, force
  it the way you forced the send failure — and if it turns out unreachable in practice, that is
  worth knowing and worth saying.
- **Steps 32–68** of `docs/qa-deep-claude-2026-09-04.md`: desktop surface, browser surface,
  multi-agent, blocked chats, recovery. Skipped for context in every prior run.

## Part 3 — the two ChatGPT findings still open

From the gauntlet run, both needing macOS:

- **Second-tab tracking.** A `target=_blank` click returned `createdTab={…}` but the next
  `status` reported only the held tab. Decide from the driver's contract whether that is correct
  ("status reports the tab I drive") or a genuine gap, then fix it or close it as a prompt error.
- **Unfocused type accepted.** `type` with the page body focused was silently accepted, where an
  earlier round found the opposite — everything refused with `INPUT_TARGET_LOST`. Something
  differs between those two cases and neither report captured what.

## Release decision

When Part 1 has an answer and Parts 2–3 are either passing or explicitly accepted as known gaps,
this branch is releasable. No version bump or tag is planned yet — the intent is a PR upstream
once it is bug-free, so `package.json` stays at 2.0.5 until that call is made.

Report pass/fail per item. For Part 1, the verbatim key lists and the digest comparison are the
report — no prose verdict is needed or wanted there.
