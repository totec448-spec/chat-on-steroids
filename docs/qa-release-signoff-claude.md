# Release sign-off — Claude Code, macOS

The last pass before this branch is proposed upstream. Standing authorization to fix and push
applies: root cause first, smallest correct fix, a regression test confirmed failing without it,
`tsc` and the full suite green before every commit, no Claude attribution.

## Before anything else: make the connector attributable

The previous round could not test the browser tool, sub-agents or blocked chats **at all** —
every call arrived Unattributed, so each was refused by design and each cost a flat 20-second
identity wait. That was correct behaviour, not a defect, and it also meant a third of the surface
went unmeasured two rounds running.

Attribution exists only when the extension has observed a real request id in a real ChatGPT turn.
So: pick the connector in ChatGPT, open a real conversation, and make one tool call from it.
Confirm the app reports a non-null `lastToolCallAt` and that the call is attributed. **If that
cannot be arranged, say so at the top of your report and mark Parts C, D and E as blocked** —
do not spend the session working around it, and do not forge identity through `/pair` and
`/correlations`. You were right to refuse that last time: it rotates the live token out from
under the user's extension, and a forged identity is a poor instrument for measuring an
identity-sensitive path.

## Setup

`git pull` → `c44be15` or later. Install the macOS arm64 artifact from the newest green *Release
candidate* run, fresh. Then baseline:

    npx tsc --noEmit
    npx vitest run
    npm run verify:privacy
    npm run verify:browser
    npm run verify:compact-chain

The last one is new since your report and answers Part 1 of the previous brief in a single run.
Confirm the digest it prints matches the app's connect line — which should now always carry one:
your `(build unreported)` finding was correct and is fixed in `c44be15`, with `hello()` waiting
for the digest (bounded at 250 ms) while every other request still does not.

## Part A — what your last report left genuinely unrun

1. **Step 61, block a chat mid-generation.** Never run on any build. Block while a turn is
   actively generating, not idle. Confirm the refusal is named, the turn stops cleanly, and
   releasing restores tools on the very next call.
2. **Step 66, kill between the durable session move and its projection publish.** The crash
   boundary continuation recovery exists for. Needs a live handoff to hit.
3. **`destinationLost` driven by hand.** It reaches the app and behaves correctly at every link —
   you proved that — but nobody has driven a real Compact & Resume to chat B and cleared the
   composer before the click. Do that.
4. **Step 52, browser against a hostile page.** The fixture has an iframe and nothing else. Use a
   page with a real popup or new-tab flow, a redirect chain, and heavy nested frames.

## Part B — the full surface, once, on the shipping build

Work `docs/qa-deep-claude-2026-09-04.md` steps 32-68 again if anything changed, but do not repeat
what you have already recorded as passing on this build unless the code moved under it. Your last
report is the baseline; this is a delta check, not a rerun.

## Part C — sub-agents, end to end (needs attribution)

Never exercised beyond fences. Spawn a prime, spawn a worker, have it do real work and report
back, read the result from the prime. Then: worker revival from a parked state, a worker blocked
mid-run, and confirm the swarm slot frees rather than deadlocking.

## Part D — blocked chats, end to end (needs attribution)

Idle, mid-generation, and a worker chat. Confirm Goal and Loop refuse from a blocked chat's own
composer while auto-compaction remains settable from a different chat — the claim `a0aa00e`'s
message makes.

## Part E — browser over MCP (needs attribution)

`verify:browser` exercises the driver against real Chrome and covers the substance, but the
delivery path from an attributed ChatGPT call has never run. Drive one real browser action from a
real conversation and confirm it lands.

## Part F — the release question

When the above is done or explicitly blocked, answer this directly, because it is what the work
is for:

- Is there any defect you would not ship?
- Is there anything a first-time user would hit in the first ten minutes that would make them
  distrust the app?
- What is the weakest part of this surface, in your judgement, and is that weakness documented
  where a user would find it?

## Report

Pass/fail per item. Every fix with its commit hash. For Part F, prose is wanted — that section is
a judgement, not a checklist.
