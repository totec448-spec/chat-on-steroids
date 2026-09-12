# Completed-chat recovery and background Usage refresh

Session hydration now replays the current generation in committed lifecycle order.
A new start replaces the active turn and only its matching end clears it. Older
turns with missing ends remain historical records, so closing and revisiting a
completed chat cannot revive them. Explicit new work still earns normal recovery.

Startup warms the existing Usage cache once without delaying the UI. Page visits
share that calculation; changed sessions are read sequentially with an event-loop
yield, unchanged sessions reuse cached totals, and quitting cancels pending work
before cache publication. English and Chinese loading text explains the rebuild;
transport failure restores a retryable status. Existing context caps are preserved.

Publication preparation fetched current public main and applied only the new
workspace diff in an isolated worktree. Existing public fixes, sanitized fixtures,
release metadata and documentation were retained. Private local history, worklogs
and evidence are excluded. The shared source checkout remains unchanged.

Validation: full `npm run verify` passed, including privacy, dependency/native-source
notices, TypeScript, 4,026 tests and two separately executed shutdown tests; 40 opt-in
tests were skipped. `npm run build`, staged privacy verification, an added-content
scan for credentials/private paths/conversation links and `git diff --check` passed.
Regressions cover repeated closure/history hydration, later explicit work, lifecycle
ordering, shared sequential Usage calculation, warm-cache reuse and cancellation.
Source/test/build evidence does not establish installed or live browser behavior.
