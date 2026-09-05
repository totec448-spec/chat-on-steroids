# Confirmation round — Claude Code, macOS

Second confirmation round. The previous one closed Findings 2 and 3 live and ran the sub-agent
loop end to end for the first time; what is left is one item it could not reach, one it carried
from an older build, and one that is open on evidence rather than on doubt. The browser-tool steps
are **not** here — they need an attributed ChatGPT conversation and live in
`docs/qa-confirmation-chatgpt.md`.

Standing authorization to fix and push applies: root cause first, smallest correct fix, a
regression test confirmed failing without it, `tsc` and the full suite green before every commit,
no Claude attribution in commits, PRs or tags.

## Setup

`git pull` → `03f8f27` or later. Install the macOS arm64 artifact from the newest green *Release
candidate* run, fresh. Then baseline:

    npx tsc --noEmit
    npx vitest run
    npm run verify:privacy
    npm run verify:browser
    npm run verify:compact-chain

Expected: everything green, nothing failing. **Do not expect a particular count.** Both suites are
platform-gated — `it.runIf(process.platform === 'win32')` in the test suite, and one
`verify:browser` check that only runs on macOS — so the totals differ by platform and a figure
quoted from a Windows run reads as a regression here. It is not one. Judge by failures, not by
totals.

Two notes so you do not chase ghosts. `verify:browser` grew from 52 checks and now covers a native
select, a hover-revealed caption, a link click that works, a link click that reaches nothing, and a
tab holding Chrome's error page. `verify:compact-chain` needs the app running — start it first
(`npm run dev` or the installed build); it says so in one line rather than failing seven
checkpoints if you forget.

Confirm the digest `verify:compact-chain` prints matches the app's connect line.

## Part A — the one finding still open

Findings 2 and 3 were confirmed live last round and are **closed** — do not re-run them. Only one
remains open, and it is open on evidence, not on doubt about the code.

1. **Finding 1, the wedged chat.** The product decision is unchanged: the ticket still runs to its
   six-hour deadline and nothing is abandoned early. What changed is that a chat whose compaction
   pickups are spent no longer loses browser recovery for that whole window — the skip now lasts
   exactly as long as the chat is still being chased.

   The last round could not force a stalled handoff, and was right not to claim one: it needs an
   automatic compaction to reach `dispatched-unresolved` and then fifteen minutes of ChatGPT's own
   transport failing, which nobody can induce on demand. Closing the tab produces a different stall
   shape and would not exercise the same release.

   So: try once if the opportunity arises naturally, and otherwise **say it is unconfirmed and move
   on**. Do not spend the session manufacturing it. If you find a way to force the exact shape —
   three spent `writing` pickups on an open ticket — write down how, because that is the missing
   instrument and it is worth more than one more attempt.

## Part B — the failure paths

Only with an attributable connector. If calls arrive Unattributed, say so at the top and mark this
part blocked — do not spend the session working around it, and do not forge identity through
`/pair` and `/correlations`. You were right to refuse that.

2. **A worker blocked mid-run**, and confirm the swarm slot frees rather than deadlocking. This is
   the one item the last round could not reach, and it is where a broker deadlocks if it is going
   to. The spawn → work → report → prime-reads-result loop already passed cleanly, so do not spend
   the session re-running it; go straight for the failure path.

   Since that report this is pinned by a test — a real in-flight call registered through
   `trackInFlight`, the chat blocked under it, the sweep run — which passes, and which was
   confirmed to fail when `sleepAgent` is made to wait on in-flight work. `sleepAgent` consults
   the agent's state and its own finish barrier and never `runningToolCalls`, so the slot frees
   whatever the worker is in the middle of. The question here is therefore no longer "does it
   deadlock" but whether the live path agrees with the unit one. If it does, say so in a line and
   move on; a disagreement is the only interesting outcome.
3. A chat blocked **mid-generation**, not idle. Confirm the refusal is named, the turn stops
   cleanly, and releasing restores tools on the very next call. The last round carried this from an
   earlier build on an identical code path rather than re-driving it, so drive it once here.
4. While spawning that worker, watch its first command. `WORKSPACE_REQUIRED` now lists the approved
   roots. Confirm the worker can act on that in one step instead of guessing — that was the report's
   own example of a loud refusal being the second thing that ever happens in a worker's chat.

## Report

Pass/fail per item with exact evidence, and every fix with its commit hash.

Then answer directly, in prose: **is there any defect here you would not ship?** And: is there
anything a first-time user would hit in the first ten minutes that would make them distrust the
app? That judgement is what this round is for.
