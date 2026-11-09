# Recovery timing and delivery audit, 2026-09-18

Verified and corrected the user's recovery specification against the current shared
working tree. Existing unrelated changes were retained. This report describes source
changes and automated verification; no installation, application restart or release
was performed.

## Timing contract

All initial silence deadlines use the last genuine work in the exact source turn.
A failure observation, duplicate failure, page poll or repeated acknowledgement is not
new work. Silence intervention requires the existing exact-turn local MCP evidence
and applicable recovery policy. A canonical final or user Stop supersedes recovery.

| Source | Initial silence reload | Additional native-busy wait after confirmed reload |
| --- | --- | --- |
| Normal or unobserved model | 2 minutes | 1 minute |
| Proven Pro | 10 minutes | 5 minutes |
| Normal or unobserved model, Thinking failed | 2 minutes | 1 minute |
| Proven Pro, Thinking failed | 5 minutes | 5 minutes |

For shared automatic Continue, an idle restored page may proceed immediately when
the same native question still has no final. The additional busy interval is anchored
to the confirmed browser action. A delayed reload must not subtract from that interval.
Repeated failure/ACK observations preserve the same owner and deadline. Genuine work
withdraws stale recovery and restores the ordinary model-specific inactivity window.

The normal silence countdown becomes visible in its last 30 seconds. Pro becomes
visible five minutes before its deadline. Thinking failed therefore leaves the normal
display unchanged and reveals the remaining Pro five-minute deadline. Confirmed reload
and native-busy displays use the delivery owner's actual one/five-minute deadline.
Unattributed candidate displays retain their separate incident visibility rules.

Authored after-turn input retains its exclusive queue and native-readiness checks.
Its native-busy deferral now also uses one minute for normal/unknown and five for Pro;
the same authored ticket may defer again while busy. An explicit immediate user send
after a recognized failed view retains its existing manual semantics.

## Confirmed defects corrected

1. Thinking failed previously requested an immediate reload for both ordinary and
   Pro models. `bridge.ts::silenceWindowMs` now supplies the activity-based 2/5-minute
   deadline to scheduling and ticket eligibility. Failure during a queued, handed or
   completed silence repair preserves that repair's source.
2. Some ordinary failed-view/listening paths still used five minutes. Scheduling,
   queued delivery and countdown projection now agree on one/five minutes. Continue's
   busy deadline is measured from the acknowledged reload, including delayed reloads.
3. A queued message whose preceding response had already completed remained visible
   in browser offers after an explicit manual close. `browserInputAllowed` now checks
   dismissal at publication, claim and final Send authorization. Authored text remains
   queued. A real page return releases the dismissal; newly authored explicit immediate
   input retains its existing user-initiated opening behavior.
4. Injected same-turn corrections could replace the native question ID used by
   Continue, and could change the assistant-error budget key. The existing authored
   question reader now excludes those exact injected corrections for recovery callers.
   A genuine new question or foreign-turn input remains a new boundary.
5. Browser input election could remain attached to a departed tab ID after the user
   returned in another tab. A fresh app offer may now transfer to an already-existing
   tab of the exact conversation. It cannot create a tab using spent opening authority,
   borrow a different chat or displace an original tab still showing the target.
6. Cold-browser recovery for queued input required an active pending Goal reply even
   though queue and Continue use the shared pickup path with Goal Off. Startup now
   revalidates the actual durable pickup source. The common browser-startup owner
   awaits that validation before and after proving process absence.

Relevant production owners are `src/main/bridge.ts`, `src/main/browser-startup.ts`,
`src/main/session/input.ts`, `src/main/session/store.ts` and `extension/background.js`.
Obsolete timing and delivery descriptions in `AGENTS.md` were updated.

## Verified existing behavior

The authored native question owns one assistant-error reload. A later timeout or
stream-interruption notice for the same question does not earn another. The pre-action
claim spends that budget, including a lost acknowledgement; only an exact failure
receipt proving that no browser action occurred releases the reservation. Silence
has its own eligibility and is not disabled merely because the error budget was spent.

Manual departure suspends automatic missing-tab, error, silence, attribution, pickup
and compaction recovery. It does not fabricate a completed provider response or erase
owned tool history. Recovery resumes only under the existing actual-page-return or
explicit user-action rules.

An unfinished response uses shared Continue instead of inventing a Goal completion.
Canonical text and image-only finals cancel that recovery before Stop or Send. Authored
input retains chronological priority over generated Continue/Goal/Loop. A source
completion cannot drain several queued messages, and Goal/Loop waits for user input
to be consumed under its existing completion rules.

Continue, authored queue and Goal/Loop share retry gaps of **2, 5, 10, 15 minutes**, then
15-minute gaps until their 12-hour source age expires. These are successive gaps,
not absolute timestamps. Reordering or replacing the queue head on the same source
does not reset the schedule. Expiry does not delete queued user text.

Compact/Handoff has separate phase pickups: requesting the brief uses 2-minute gaps
up to five attempts, waiting for the brief uses 5-minute gaps up to three, and opening
the successor uses 15-minute gaps up to three. Its own ticket/lifetime policy remains.

Unattributed recovery retains the fixed candidate cohort and its bounded incident
budget. Its first delay is 15 seconds for a lone candidate or 60 seconds for multiple
candidates. A second attempt at the incident's five-minute boundary needs fresh
unattributed evidence after the first attempt. A visible waiting row alone is not a
new reload grant.

## Verification

Failure was reproduced before the corresponding fixes:

- Nine normal/Pro/unknown Thinking-failed timing cases across Off, Goal and Loop.
- Two manually closed queue cases, including an already claimed input, plus a
  Continue source corrupted by multiple injected corrections.
- Existing-tab return and compacted-successor return cases.
- A queued pickup's browser-startup authority while no Goal reply is pending.

After correction, the six directly affected test files passed together: **1,029 tests,
zero failures**. They cover the bridge, browser startup, desktop input maintenance,
input-delivery integration, input owner and recovery renderer.

`npm run verify` passed on this working tree: **5,219 tests passed, 45 skipped** in
the main run, followed by **6 passed** in the separately required MCP-shutdown run.
Total: **5,225 passed**. The command also completed its privacy, notice and TypeScript
checks. Skipped tests remain skipped; this is not a claim of live-provider coverage.

`npm run build` passed. `git diff --check` passed before the final report was added;
the final documentation check is recorded by the closing verification command.

Retained local logs: `.tmp/recovery-final-targeted.json`,
`.tmp/recovery-audit-verify.log`, `.tmp/recovery-audit-build.log` and the corresponding
red-regression logs. These logs are local diagnostic artifacts, not release contents.

The desktop attach attempt returned `BROWSER_TAB_CLOSED` for the selected unprotected
tab. Other live chats were not used for destructive acceptance. Native ChatGPT/installed
extension behavior after an actual deployment has therefore not been demonstrated in
this audit. The build is ready for the normal integration/release workflow.
