# Recovery boundaries and explicit tab close

## Verified failure

The original session metadata, canonical messages and application log were inspected directly.
They show an acknowledged manual tab close, later exactly attributed MCP calls, a canonical
app-delivered correction carrying the existing turn id, and repeated silence-recovery requests
without a browser-execution receipt. Under the policy running at the time, silence recovery was
still intended to reopen that closed page. The scheduler accepted the source while the countdown
and browser handout rejected its latest `user_message` without distinguishing a correction.

## Change

`readRecoveryBoundary` excludes only injected messages with an `inputId` and the requested
source turn id. It orders canonical rows by their authored position. The existing session queue
provides a consistent read; unrelated metadata flushes cannot invalidate the source. Countdown,
silence scheduling and pre-action claim use that boundary. New questions, different turns,
canonical finals and Stop retain their authority. Invalid sources retire before another repair
is queued, removing the repeated queue/discard loop.

The requested close policy supersedes the earlier manual-close-activity worklog: an explicit
`manual: true` departure now suspends Active/Generating, injection and automatic page recovery.
Late exact tool results keep their session/request attribution, but do not restore the activity
grant. Error, missing/stalled-tab, silence, Goal/queue and compaction pickups respect the persisted
dismissal. Synthetic silence inputs are revoked; authored inputs, continuation tickets and
confirmed repair receipts remain owned by their existing mechanisms. No provider `turn_end`
is fabricated.

A genuinely newer exact page poll clears dismissal through the existing recorder/store path.
An unresolved turn can then recover using its last recorded MCP timestamp, without treating
the poll as new work. Generic reattachment, older polls and late results cannot clear dismissal.
Unexpected page loss keeps its existing recovery behavior.

## Verification

The first ten targeted regressions produced eight failures before the production changes.
After the fixes, the expanded focused run passed 45 tests, including normal/Pro corrections,
new-question and Stop boundaries, manual-close inactivity, real return without another tool call,
Goal/Loop final collection, and renewed work after reload. TypeScript checking passed.

`npm run verify` completed successfully: 5,209 passing tests and 45 skipped in the main run
(210 passing suites, four skipped), followed by all six passing shutdown tests. This includes
privacy/license checks and TypeScript. The log is `.tmp/manual-close-recovery-verify.log`.
The six modified source/test files retained the same SHA-256 fingerprints throughout the full
verification. `npm run build` then completed with exit code 0; its log is
`.tmp/manual-close-recovery-build.log`.

The production application and extension have not been restarted or installed by this source
task. Isolated HTTP/IPC and renderer tests are not an installed-browser end-to-end acceptance
result. Unrelated working-tree edits were preserved.
