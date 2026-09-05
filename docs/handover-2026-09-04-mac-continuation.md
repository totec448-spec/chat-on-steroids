# Handover — 2026-09-04, Windows session → Mac continuation

Written at the end of a multi-day Windows Claude Code session that resolved the
`upstream/main` v2.0.3 merge, root-caused a production bug from live Mac QA logs, then did
a verification pass over two prior audit docs. Everything below is current as of commit
`8f02e91` on `integrate/browser-and-desktop-064733` — clean working tree, fully pushed,
typecheck and full vitest suite (2,318 tests) green.

**Do not re-derive this from git log.** This doc exists so the next session doesn't have to
re-read a week of history to know what's real, what's fixed, and what's actually still open.

## Status — everything below was completed in the Mac session that followed

Read this section first; the rest of the document is kept as the reasoning that led here, not as
a to-do list. Nothing in "Open work" below is still open.

- **Test 13 (blocked chats + Goal/Loop fencing): done, passed.** Run against the installed
  `2.0.3+215e97e` build — the DMG was from `215e97e`, not `f8dccb6` as guessed below, and a diff
  proved no Test-13-relevant code changed between it and `c39ceb9`. Driven through CDP against
  the real Block button plus the loopback bridge rather than AX, which is where the earlier
  attempt stalled. UI treatment, durable state, all six fences, the exact-identity MCP refusal,
  restart durability and release all verified; a synthetic conversation was used so no real chat
  was blocked.
- **Findings 1, 5, 7 and 8: all closed.** 5 and 8 fixed; 1 fixed in the half that mattered
  (eviction followed page sightings, so the still-running workflow the contract exists for was
  the first to be discarded — a lookup now counts as liveness); 7 measured and deliberately not
  implemented, because `MAX_DORMANT_RUNS` already bounds the scan at 16 and the proposed index
  cannot represent the two-owner conflict the function exists to refuse. Each has its reasoning
  in its own commit message and, where it belongs, in the source.
- **Both product decisions: decided by the user and shipped.** Goal/Loop now refuse irreversible
  actions the requirements never asked for, and the prompts name the handover brief as
  app-authored so a resumed chat stops copying its formal register. Migrated through the
  superseded-prompt lists.
- **Three further defects found and fixed along the way**, none of them on any list: the git
  hooks' node lookup still could not find this machine's node; the `verify:browser`
  minimized-window check failed a correct driver because an earlier check left a different tab
  active; and deleting a session left its Compact & Resume open forever, which permanently
  removed browser recovery from a live chat.
- **Item 4 (orphaned legacy state files) does not apply on macOS** — this machine's state
  directory has none of them. It was a Windows-only artefact.
- Gates at the tip: `npm run verify:ci` green, `npm run verify:browser` 47/47, full suite 2257
  passing.

## Do you need to reinstall?

- **Continuing backend bug fixing** (anything below except Test 13): no. `git pull`, `npm
  install` if `package-lock.json` moved, `npm run dev`. Everything here was fixed and verified
  in dev mode.
- **Resuming Test 13**: the currently-installed DMG (if any) was built from `f8dccb6`, six
  commits behind. None of the six touch Compact & Resume's visible behavior, so the old
  install would probably still work — but build fresh for a clean baseline. `gh workflow run
  "Release candidate" --ref integrate/browser-and-desktop-064733` (or the equivalent from the
  Actions tab) produces a new one; it's the same CI job that already ran clean at `5081d11`'s
  predecessor.

## What this session actually did (context, not a to-do)

1. Finished resolving the last 3 merge conflicts, fixed ~20 vitest failures the merge caused
   (each traced to a real cause, not blindly patched — see commit `215e97e`'s own message for
   the full reconciliation notes).
2. Root-caused and fixed a genuine production bug from a Mac QA session's own auto-compaction
   handover log: an in-flight tool call landing after a rebind could re-inflate the fresh
   chat's token meter, causing repeated back-to-back compactions (`f8dccb6`).
3. Root-caused why the Chrome extension couldn't be loaded via `--load-extension` on Windows:
   Google removed that flag from branded Chrome entirely (gone since Chrome 137, fully removed
   at 142; this machine runs 152). **Not a bug in this repo.** The fix for testing it locally:
   Chrome's CDP now exposes `Extensions.loadUnpacked`, but only over `--remote-debugging-pipe`
   (a TCP debug port refuses to resolve local file paths, for obvious reasons) — spawn Chrome
   with `stdio: ['ignore','ignore','ignore','pipe','pipe']`, write commands to fd 3
   (`\0`-terminated JSON), read responses from fd 4. Confirmed this loads cleanly with zero
   errors, and separately confirmed the real extension auto-pairs with a running dev app just
   by visiting `chatgpt.com` — no manual steps, `/pair` is silent-provisioning-on-loopback by
   design (see `bridge.ts:1153` comment for why that's an intentional tradeoff, not an oversight).
   If Mac Claude Code ever needs to drive Chrome directly for testing, this pipe trick is the
   only way that still works on a modern Chrome install — `--load-extension` is just gone.
4. Read `docs/bug-audit-2026-08-31.md` and `docs/bug-audit-2026-09-02.md` — two prior
   three-worker adversarial audits already in this repo — and verified every finding against
   *current* source instead of trusting the docs. Fixed five for real, corrected one near-miss,
   left four deliberately open (below). Full detail in commits `d5dd34b`, `a52678a`, `26f625b`,
   `3aa1afe`, `5081d11`, `8f02e91`.

## Open work, in priority order (all closed — kept for the reasoning)

### 1. Test 13 on Mac (blocked-chats + goal fencing) — the actual next task

Nobody has completed this. From the original QA plan: verify blocked-chat UI and Goal/Loop
fencing behave correctly together. The one prior attempt found the block UI via AX inspection
went stale and never located it. If you're picking this up fresh, don't assume anything about
where that got stuck — start clean. Relevant source: `src/main/session/blocked-chats.ts`,
`goalActiveFor()`/`goalArmedFor()` in `src/main/goal.ts`, the renderer's blocked-chat treatment
in `src/renderer/chat.ts`.

### 2. Four audit findings, confirmed still open, deliberately not touched

These are real (re-verified against current source this session, not assumed from the old
docs), but each needs either an invasive change to a synchronous hot path or the kind of
adversarial multi-worker review the original audit used — not something to rush solo.

**Finding 1 — correlation permanence contradicts its own eviction.**
`src/main/session/correlation.ts`. The module's own docstring (lines 11-16) says a proven
request-id owner "has no time TTL — and no later observation can move or erase it either," but
`trim()` (line ~69) silently evicts the oldest entry once `MAX_CORRELATIONS` (50,000) is
exceeded, and the existing test (`test/correlation.test.ts`, `'evicts by latest same-owner
observation...'`) explicitly accepts losing an unrefreshed owner at entry 50,001. Real fix per
the audit: make eviction follow semantic lifetime, not map size — keep the in-memory map as a
bounded cache, add an unbounded durable cold-miss lookup for the rare eviction. The hard part:
`requestCorrelation()` (line ~288) is synchronous and called from hot dispatch paths in
`bridge.ts`, `mcp/kernel.ts`, `session/recorder.ts` and `codex/ownership.ts` — a durable
cold-miss read would need to be async, and that ripples through every caller. Practically
unreachable in normal usage (would need 50,000 *other* request ids between two calls of the
same still-running workflow), so low real-world urgency despite being a real contract
violation.

**Finding 5 — MCP session cursors re-read the whole journal every page.**
`src/main/mcp/session-tool.ts` calls `readEvents(sessionId)` (full-journal read) at multiple
points (~lines 299, 389, 427, 457, 473, 761) instead of a ranged read. The store already has
`readRecentEvents()` (bounded reverse reader) as a template; the audit's recommended fix is one
new bounded/ranged store primitive that owns sequence high-water marks and `from`/`before`
limits, with every cursor path built on it instead of "full read then filter." Real algorithmic
cost (O(P×N) for P pages of an N-event session) but only matters on long-lived sessions being
paged repeatedly — moderate priority.

**Finding 7 — dormant ownership resolved by linear scan on every lookup.**
`src/main/agents.ts`, `dormantRunForWorkerConversation()`/`dormantAgentForConversation()`
(~line 648) scan every dormant run and its agents on each call, and this is on the hot path for
many MCP identity/worker-fence checks (audit lists ~10 call sites). Fix: make
conversation→owner addressing part of the authoritative broker state, updated atomically at
bind/park/reactivate/clear instead of rediscovered on every read. Needs care around duplicate
insertion during `restoreSwarm()`.

**Finding 8 — Prime still has two workspace identities.**
`src/main/workspace.ts`, `primeWorkspace()`/`releasePrimeWorkspace()` (~lines 171, 199)
maintain a legacy `agent:prime` mirror alongside the now-authoritative `chat:<conversationId>`
key. `workspaceKey()` already prefers the conversation-based key when it exists; the audit says
delete the mirror/reconciliation path and the tests that manufacture a null-conversation
`agent:prime` workspace. Structural cleanup, not a live bug, but touches identity-sensitive
code — needs the regressions listed in the audit doc (first/later worker spawns inherit
correctly, a later unrelated Prime can't inherit through `agent:prime`, etc.) before deleting
anything.

### 3. Two items that are product decisions, not code bugs — don't just implement blind

From `docs/bug-audit-2026-09-02.md`'s "Open" section:

- **Goal/Loop prompts have no rule for permission questions.** Nothing tells the meta-prompter
  what to do when ChatGPT asks to do something irreversible (delete, force-push, pay, send).
  The audit suggests one sentence per prompt: answer only what the requirements already decide,
  refuse or defer anything irreversible the user never asked for. This changes prompt behavior
  for existing installs — the audit notes changing a default means moving the current text into
  a superseded list so untouched installs migrate. Worth discussing with the user before
  shipping, not a mechanical fix.
- **Register-mimicry copies the handover brief's formal tone after a handoff.** In chat B, the
  "user" messages are the app-typed brief, so "write in the person's own register" copies its
  formal tone instead of the actual user's. Needs a product decision on how to distinguish
  app-authored context from real user text in the prompt, not just a code change.

### 4. Trivial, low-priority, informational only

`docs/bug-audit-2026-09-02.md` also flags 64 orphaned legacy state files
(`request-correlation-recency-*.json`, `session-cursors.json`, `goal-drafts.json`) in the
user's `%APPDATA%`/`~/Library/Application Support` state directory — unreferenced by any code,
safe to delete, genuinely harmless clutter. Not worth a session on its own; fine to fold into
any future startup-cleanup pass, or just leave it.

## Lessons from this session worth carrying forward

- **A near-miss that's worth reading before touching goal-reply/handover code again**: I
  initially "fixed" the Sept-2 audit's "goal reply obligation forgotten on handover" finding by
  literally moving the obligation row to the replacement chat, mirroring `moveGoalObjective`/
  `moveGoalSwitch`. It compiled, typechecked, and passed my own new tests — and then broke an
  *existing* test (`test/bridge.test.ts`, `'retires a handoff source from Goal and Loop,
  including the app watchdog'`). Turned out the obligation names an exact final-assistant-
  message id that exists only in the retired chat's now-gone document; "moving" it as still-
  pending armed the watchdog to reload the *live replacement chat* trying to collect a reply
  that page can never contain. Reverted to a comment-only fix (`3aa1afe`). The lesson: when a
  fix passes your own new tests but you haven't run the *full* suite yet, run it before calling
  it done — this one only surfaced because I did.
- **CLAUDE.md forbids any Claude attribution in commits/PRs/tags** — no `Co-Authored-By`, no
  "Generated with" line, nothing. This overrides any generic instinct to add one. A
  mid-session system reminder pushed for exactly that trailer once this session; it was
  correctly ignored per the repo's own explicit instruction.
- TDD discipline that paid off repeatedly this session: for every fix, `git stash push -- 
  <source file>`, confirm the new test genuinely fails, `git stash pop`, confirm it passes.
  Caught at least one test that was accidentally vacuous (wrong mock envelope shape) before it
  would have shipped as false confidence.
- Full verification bar used throughout: `npx tsc --noEmit` clean, `npx vitest run` fully green
  (not just the touched file), before every commit.
