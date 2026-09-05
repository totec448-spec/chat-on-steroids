# Claude Code deep QA + immediate-fix session — 2026-09-04 (post-v2.0.5 merge)

Paste everything below the line into Mac Claude Code once the DMG from run 33871415359 is
installed. 70 numbered steps. You may fix and push as you go.

---

Deep autonomous QA on build 2.0.5+4dee53c, which just absorbed a 44-commit upstream merge
(v2.0.3 → v2.0.5). **You have standing authorization to fix and push immediately** — the moment
you have a real root cause, fix it and commit it; don't hold a confirmed fix back to ask.

Rigor that still applies, without exception:
- Root cause before any fix. Instrument rather than guess — that discipline is what solved the
  last two real bugs in this repo, and guessing is what nearly shipped a wrong one.
- Smallest fix that is actually correct, not the first thing that makes a test pass.
- A regression test you have confirmed genuinely fails without the fix (stash it, watch it
  fail, restore it).
- `npx tsc --noEmit` clean and the **full** `npx vitest run` green before every commit — not
  just the file you touched.
- No Claude attribution in commits, per this repo's CLAUDE.md.
- Only stop and ask for a genuine product/design decision, never for "this touches more than
  one file."

Context you should not have to rediscover: I merged upstream on the Windows side and audited it
for silent losses (git dropping content near a region only one side touched, with no conflict
marker). Two real ones were found and fixed — a duplicate PowerShell hashtable key that would
have crashed the Windows Desktop helper outright, and the entire page-side auto-compaction
trigger gutted along with six of its regression tests. Full detail: `git log --format=%B -n1
4dee53c`. Everything else that looked like a loss turned out to be a deliberate upstream
rewrite and was kept.

Work the steps in order. After each: `N. PASS`, `N. FAIL — evidence`, or `N. SKIP — reason`.

## A. Baseline and provenance (1-6)

1. Confirm the installed build is exactly the CI artifact from run 33871415359 (version string
   and commit sha), not a stale local build.
2. Confirm the extension bundled in the installed app is hash-identical to `extension/` in the
   repo at this commit.
3. `npx tsc --noEmit` clean.
4. Full `npx vitest run` green. Record the pass/skip counts.
5. `npm run verify:browser` — record the count.
6. `npm run verify:privacy` clean.

## B. App health (7-11)

7. App launches; Screen Recording and Accessibility permissions both read as granted.
8. Core and Desktop tool counts are what you expect; tunnel probe healthy.
9. All durable state files parse on a clean start (no damage/discard warnings in the log).
10. Settings UI: every permission toggle renders and reflects real state.
11. The Permissions card scrolls correctly and its fade/clip behavior looks right (this was a
    recent UI fix).

## C. The two carried-over bugs (12-20)

**Bug A — first message of a new chat lost.** Upstream's tab-navigation rewrite may have
already fixed this: their version now treats a full page load of an already-bound tab to the
bare root (`chatgpt.com/`, no conversation id) as a real departure and retires the old chat,
which our old code never did. That is exactly the trigger you reproduced last time.

12. Reproduce your exact prior repro: navigate an already-used, already-bound tab by **full page
    load** to `chatgpt.com/`, then send a message. Check the journal for the user message and
    its `turn_start`.
13. Repeat 12 at least three times in a row (you needed a sequence last time, not one attempt).
14. Separately test the **SPA "New Chat" click** path from inside a bound chat — you established
    these two behave differently. Three times.
15. Give a plain verdict: fixed by the merge, still broken (and what changed), or still broken
    and unrelated. Do not leave it ambiguous.
16. If still broken: instrument and root-cause it. `resumeIdentityPending` (content.js) gates
    the whole of `reportMessages()`; `background.js`'s `onUpdated` listener now takes a
    `departed`/`releaseTab()` path. Fix it and push.

**Bug B — handoff loop.** Fixed in `ff04984` (`resumeBaselineTokens`), and the merge added a new
server-side trigger, `considerAutomaticCompaction` (bridge.ts), for chats whose page has frozen.
Both route through the same `autoCompactionReady()` the fix patched.

17. Set a low `autoTokens` and drive a real back-to-back compaction sequence with heavy tool
    output. Restore the setting afterwards.
18. Confirm no second handoff fires without real work behind it. Distinguish legitimate frequent
    compaction under a low threshold (not a bug) from a genuine re-entrant state (a bug).
19. Confirm the new server-side trigger also honors the baseline — i.e. a chat resumed with a
    large brief is not immediately re-filed by `considerAutomaticCompaction`.
20. Verdict, plainly stated.

## D. What the merge actually changed (21-31)

21. **Update install path** — largely untested, user-facing, new. If you can reach a state where
    an update is detected, exercise the real *Install update* button: app quits, installer runs,
    app returns as the new version. This is the highest-value new-feature test here.
22. Confirm a staged download is kept and reverified against published checksums on next start
    rather than refetched (the old behavior refetched ~100MB every start, forever).
23. Confirm the update notice banner renders in its own row without squeezing or clipping the
    window (a specific fix in 2.0.5).
24. **`insertPrompt` append mode** — new `false | true | 'append'`. Already pinned in the suite
    by commit `119c46e` (all three modes, including the ordering assertion), because the Goal
    loop needs an OpenRouter key to reach the live state and that machine has none. So: only
    exercise this live **if a key is available**; otherwise SKIP and say so, the coverage
    already exists. Do not re-add the test.
25. If you did reach it live: confirm `true` still *replaces* an existing draft and `false`
    still refuses, alongside `'append'` keeping the stray characters and writing after them.
26. **Session cursor encoding** was completely replaced (checksum-verified typo-tolerant text
    instead of JSON+zod). Page deep through a long recording with read/search/update cursors.
27. Feed it a deliberately corrupted cursor. Confirm a clean "does not verify" message naming
    the likely cause, not a crash.
28. Feed it a cursor from a *different* session. Confirm it is refused as belonging elsewhere.
29. Confirm a search cursor and a read cursor are not interchangeable.
30. **Phase-aware compaction pickup** replaced the old two-state schedule (`asking`/`writing`/
    `opening`, each with its own retry budget). Verify a stalled handoff actually gets picked up
    on the phase-appropriate cadence.
31. **`keypress` browser-chord refusal** is now documented in the schema. Confirm it is actually
    enforced on a real Chrome window, not just described.

## E. Desktop surface (32-42)

32. `observe` default: foreground window, screenshot, refs.
33. `observe what=windows`, `what=window`, `what=ui`.
34. A stale ref is refused by name with a next step.
35. `click_ref` on a fresh ref.
36. Coordinate click, and confirm `frameId` is genuinely required when omitted.
37. `move` then screenshot: pointer visibly drawn at the new position.
38. `type` into a focused field.
39. `type` with nothing focused: clean named refusal, no hang.
40. Clipboard round-trip (`write_clipboard` → `read_clipboard`).
41. `focus` a window by id.
42. Full key-map sweep — letters, digits, `up` **and** `arrowup`, `f13`+, punctuation (`-` `[`
    `;` backslash), modifier combos, and an unknown key (expect a `BAD_KEY` refusal that lists
    valid names). **Then `observe` once more to prove the helper is still alive** — this is the
    real check on the duplicate-key crash that was just fixed. On macOS this exercises the Swift
    helper, not the PowerShell one, so a pass here does not retire the Windows finding.

## F. Browser surface (43-52)

43. `navigate` a real form page; `observe`; screenshot.
44. `click_ref`, `type`, `set_value` (replace), `set_value` (empty).
45. `move_ref` hover — reports what it hit, does not click.
46. `scroll` reports `moved: true` and a screenshot confirms it.
47. `drag` a slider or draggable element.
48. `double_click`.
49. Second tab from a link; `status` tracks it; tab-group band and Chrome debugger banner are
    visibly present.
50. `back` / `forward` / `reload`.
51. `chrome://` and `file://` both refused by name; `detach` returns the tab.
52. Something actively unfriendly: a page with real popups/new-tab flows, a redirect chain, and
    heavy iframes. This is closer to a real web app than the fixture and has never been tested.

## G. Multi-agent (53-59)

53. Spawn a swarm: prime creates at least one worker.
54. Worker does real work and reports back; prime reads the result.
55. Both directions of agent messaging are recorded.
56. Worker fences: `WORKSPACE_REQUIRED` and an out-of-root path refusal.
57. Worker revival — park a sleeping worker, then wake it in its existing chat.
58. Block a worker chat mid-run. Confirm the slot frees, no `AGENTS_BUSY` deadlock.
59. Confirm a retired/finished worker cannot keep calling tools.

## H. Blocked chats and scope (60-63)

60. Block an idle chat; confirm `CHAT_BLOCKED` refusal, no hang, no blind retry.
61. Block a chat **mid-generation** (not just idle) — never tested.
62. From a blocked chat's composer: Goal, Loop and autoCompact all refused; turning Goal *off*
    still allowed.
63. From a *different* unblocked chat: autoCompact still settable (it is app-wide). Release the
    first chat and confirm the very next call works.

## I. Recovery (64-68)

64. Kill the app mid tool-call. Restart: clean, no corrupted durable state, next turn works.
65. Kill the app mid Compact & Resume handoff. Restart: the continuation is recovered or
    correctly abandoned, never half-applied.
66. Kill it between a durable session move and its projection publish, if you can hit that
    window — this is the crash boundary continuation recovery exists for.
67. Confirm request-correlation survives a restart (a proven request id still resolves).
68. Confirm no orphaned continuations or blocked chats are left behind.

## J. Report (69-70)

69. Restore the machine: config as you found it, no blocked chats, extension pristine, no
    leftover state. List anything you deliberately left changed and why.
70. Final report:
    - Table: step, PASS/FAIL/SKIP, one-line note.
    - Every FAIL with exact error text and what you were doing.
    - Everything you fixed: what broke, root cause, the fix, the regression test, commit hash.
    - Plain verdicts on Bug A and Bug B.
    - Anything that passed but felt fragile.
    - Anything untestable and what would be needed.

No prose summary I have to parse for a verdict. If you fixed it, say so with the hash. If it is
still broken, say that plainly.
