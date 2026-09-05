# Claude Code autonomous QA + fix session — 2026-09-04

Paste everything below the line into Mac Claude Code. It's written to run end to end without
anyone answering questions mid-session — drive the app, Chrome and ChatGPT yourself the way
you have all along (UI automation, AppleScript, direct DevTools protocol, whatever you've been
using), rather than asking a human to click or type anything. You have standing authorization to
ship fixes directly.

---

Autonomous QA pass. No one is going to answer questions while you run — if you'd normally ask
"should I..." or "can you confirm...", make the call yourself and note what you decided and why
in the report instead. You have full authorization to ship fixes as you find them: root-cause it
first, smallest fix that's actually correct, a regression test you've confirmed genuinely fails
without the fix, full local verification (tsc + full vitest, not just the touched file) before
every commit, no Claude attribution anywhere per this repo's CLAUDE.md. Only hold off shipping
for a genuine product/design call, not because a fix touches more than one file.

## 0. Baseline

Confirm the installed build matches the latest green CI run on
`integrate/browser-and-desktop-064733` — if it doesn't, decide yourself whether to rebuild/
reinstall before continuing (you don't need to ask). Check `compaction.autoTokens` in the app's
current config: it was found at 10000 (the schema's supported floor) during the last QA pass,
which very plausibly explains the "handoff loop" symptom as frequent-but-legitimate compaction
under a low threshold rather than a distinct bug. Decide what to test at: leaving it low is
actually useful for exercising compaction/handoff machinery hard, as established practice in this
project's own QA history, but if you leave it low, don't mistake ordinary frequent compaction for
the loop bug — the two need to be told apart by evidence (see part 2 below), not assumed either
way.

## Part 1 — full-surface autonomous sweep

Everything from the last two QA passes, done without needing a human present:

- exec_command, read, browser, computer, session tool — same depth as the QA prompts already in
  this repo's history (rapid commands, large files, real-site browser interaction, focused vs
  unfocused Desktop input, session search/read/cursor).
- Goal/Loop: turn on, give a real objective, let it draft/pick up, turn off, confirm it stops.
  Confirm mutual exclusion between the two.
- Blocked chats from multiple angles: block idle, block mid-generation, block a worker chat
  specifically. Confirm the scope claim once more, independently: Goal/Loop genuinely refuse from
  a blocked chat's own composer, auto-compaction still works from a different chat's composer
  while this one stays blocked.
- Multi-agent/swarm end to end: prime spawns a worker, worker does real work and reports back,
  prime reads the result. Worker revival (park a worker, bring it back). Block a worker chat
  mid-run and confirm the swarm slot frees cleanly, no deadlock.
- Crash recovery: kill the app mid tool-call and mid a Compact & Resume handoff (two separate
  tests), confirm clean restart both times with no corrupted durable state.
- Browser tool against something actively unfriendly: a page with real popups/new-tab flows, a
  redirect chain, heavy iframes.

Report each as pass/fail with evidence, same discipline as always.

## Part 2 — the two open bugs, with instrumentation-first investigation

### Bug A: first message of a new chat lost when "New Chat" is clicked from an already-open chat

I traced the exact mechanism by reading content.js; you don't need to rediscover this part, only
verify it live:

- `observe()` (~line 2090) branches on the conversation id changing. `if (!id && conversationId)`
  (~line 2195) fires when the URL goes id-less (the New Chat screen) while this tab was already
  bound to a real chat — it deliberately holds all state and returns early.
- When the new chat's real id appears, `if (id && id !== conversationId)` (~line 2108) fires.
  Because the *old* local `conversationId` is still truthy, it takes the `if (conversationId)`
  branch (~line 2119): retires the old chat, `epoch++`, `resetConversation()`, which sets
  `resumeIdentityPending = Boolean(conversationId)` (~line 1492) — evaluated against the
  *already-reassigned* new id, so true.
- `resumeIdentityPending = true` gates the entire `reportMessages()` function (~line 1894) —
  nothing is recorded at all — until `pullActivity()`'s `/activity` round-trip resolves it back
  to false. `resetConversation()` kicks that round trip off immediately.
- A genuinely fresh tab never sets this: the old local `conversationId` is empty, so it takes a
  different branch (~line 2143) that skips resumeIdentityPending entirely. That's the real
  difference between "fresh tab" (worked in earlier testing) and "New Chat from an existing tab"
  (the actual repro shape: FIRSTA, FIRSTB, FIRSTC in one tab).

What needs live instrumentation, not more reading: does the `/activity` round-trip for a
conversation the app has *never heard of* (this message would be the first thing it ever
records for this id) resolve as fast and cleanly as it does for a chat the app already knows?
And does the first message's DOM section stay stable between the gate opening and closing, or
does ChatGPT's own rendering do something to it in that window (recycle it, remount it, start
streaming a reply into a sibling node) that could make it textless/stale/retired by the time
`reportMessages()` finally runs again?

Instrument `resumeIdentityPending`'s set/clear timestamps, the first message's DOM/text state at
both moments, and `domWillJournal()`'s verdict the moment the gate clears. Reproduce by clicking
New Chat from an *already-open, already-bound* chat, several times in a row (matching the
FIRSTA→FIRSTB→FIRSTC pattern), not from a fresh tab. If you confirm where the message actually
gets lost, fix it there — don't fix resumeIdentityPending's existence itself, it's protecting a
real invariant (see its own comment).

### Bug B: the handoff/compaction "loop"

Before treating this as a bug at all: reproduce a real back-to-back compaction sequence (low
autoTokens, heavy tool output — screenshots are the fastest way to cross a low threshold) and
distinguish two possible explanations with actual evidence, not assumption:

1. **Legitimate frequent compaction.** Each handoff completes cleanly, the replacement chat does
   real work, crosses the threshold again on its own new activity, and compacts again. Annoying
   at a 10k threshold, not a bug — this is what a low threshold is *for*.
2. **A genuine stuck/re-entrant state.** A second handoff prompt gets dispatched while the first
   one's continuation is still open and unresolved in continuation.ts, or `COMPACTION_IN_PROGRESS`
   persists well past its own TTL without self-clearing (watch `sweep()` in continuation.ts — does
   it actually expire the entry if you just wait, or does it never clear no matter how long you
   wait), or a replacement chat gets a handoff prompt before it's done any real work at all.

Only chase (2) as a bug. If everything you observe is (1), say so plainly and don't invent a fix
for behavior that's working as designed under a low threshold — that would be exactly the kind
of guess this project's own history has already been burned by twice.

## Report

Part 1: pass/fail per item. Part 2: for each bug, either "confirmed root cause, fixed, here's
the evidence and the regression test" or "reproduced but root cause still unclear, here's exactly
what I observed" — never a guess dressed up as a fix. List anything you shipped, with commit
references.
