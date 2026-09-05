# Claude Code post-merge QA + immediate-fix session — 2026-09-04

Paste everything below the line into Mac Claude Code once the DMG from run 33871415359 (or
later) is green. You have standing authorization to fix anything you find, immediately, the
moment you've root-caused it — don't hold a confirmed fix back to ask permission. Full rigor
still applies: root cause before any fix, smallest fix that's actually correct, a regression
test you've confirmed genuinely fails without the fix, full local verification (tsc + full
vitest) before every commit, no Claude attribution anywhere per this repo's CLAUDE.md.

---

This build (2.0.5+4dee53c) just absorbed a 44-commit upstream merge (v2.0.3 to v2.0.5). I did
the merge and a manual silent-loss audit on the Windows side, and found real damage the
auto-merge caused silently (no conflict marker, still broke things) — full detail is in the
merge commit message (`git log --format=%B -n1 4dee53c`) if you want it. Short version: a
duplicate PowerShell hashtable key that would have crashed the Windows Desktop helper (fixed,
verified live on Windows — not your concern on Mac, the Swift helper is a separate file and
compiled clean in CI), and the entire page-side auto-compaction trigger silently gutted along
with its six regression tests (fully restored). Everything upstream changed that looked
concerning on inspection turned out to be deliberate and better; kept as-is.

Install fresh — full uninstall/reinstall, not layered on whatever was there.

## Part 1 — the two carried-over bugs, now on merged code

**Bug A (first message of a new chat lost when navigating from an already-bound tab).**
Upstream's own rewrite of the tab-navigation listener (background.js) may have already fixed
this — it's real news, not assumed: their version now treats a full-page-load navigation of an
already-bound tab to the bare root (`chatgpt.com/`, no conversation id) as a real departure and
retires the old chat properly, which our old code never did. That's the exact gap in your last
live-reproduced trigger. Re-test with your exact prior repro shape: **navigate an
already-used, already-bound tab via a full page load to `chatgpt.com/`** (not an SPA "New Chat"
click — you found those two behave differently), then send a message, several times in a row.
If it's genuinely fixed, say so with the evidence (journal showing the user message present,
same way you disproved it before). If it still reproduces, you now have a cleaner surface to
debug from than last time — the background.js mechanism changed, so re-trace from scratch
rather than reusing old assumptions about which branch fires.

**Bug B (handoff loop).** The fix (`ff04984`, resumeBaselineTokens) is already shipped, and the
merge added something relevant: a new server-side trigger, `considerAutomaticCompaction`
(bridge.ts), that fires compaction for a chat whose page has frozen and can't ask for itself —
complementary to the page-side trigger, and it routes through the same `autoCompactionReady()`
the fix patched, so it should already be covered. Confirm this holds: reproduce a real
back-to-back compaction sequence (low autoTokens, heavy tool output) and verify no
loop — same distinction as before, legitimate frequent compaction under a low threshold is not
a bug, a second handoff with no real work behind it is.

## Part 2 — what's actually new in this merge, worth real testing

- **The update mechanism is substantially new** (an "Install update" button that quits the app,
  runs the installer, and comes back as the new version; a staged download reverified against
  checksums instead of refetched every start). If you can reach a state where an update is
  detected, exercise the actual install button, not just the download. This is a real,
  user-facing feature nobody has tested yet.
- **`insertPrompt`'s new `append` mode.** Fixes a documented bug where a stray leftover
  character in the composer blocked a finished Goal reply from ever sending. If you can get a
  Goal reply queued while the composer has a stray character in it, confirm it now appends and
  sends rather than refusing.
- **`computer`'s keypress refusal for browser chords.** The schema now explicitly documents
  that a browser tab/window/address-bar chord is refused. Confirm it actually is, on a real
  Chrome window, not just documented.
- **Session cursor system was completely replaced** (checksum-verified, typo-tolerant text
  encoding instead of the old JSON+zod scheme). Page deep into a long recording with `session`
  read/search/update cursors and confirm nothing breaks, especially an old-style cursor from
  before the merge if you happen to have one saved anywhere — it should fail cleanly with the
  "not a session cursor" message, not crash.

## Part 3 — broad regression sweep

Everything from the last two QA passes that's cheap to re-run and expensive to skip: multi-agent
swarm end to end (spawn, work, report, prime reads it), worker revival, blocked chats from
multiple angles (idle, mid-generation, worker chat), crash recovery (kill mid tool-call, kill
mid Compact & Resume handoff), the browser tool against something actively unfriendly (popups,
redirects, iframes).

## Report

Pass/fail per item, not prose I have to parse for a verdict. For anything you fix: what broke,
why, the fix, and the regression test — plus the commit hash once it's shipped. For Bug A/B
specifically: a plain verdict, "confirmed fixed by the merge," "confirmed still broken, here's
what changed," or "confirmed still broken, unrelated to the merge" — don't leave it ambiguous.
