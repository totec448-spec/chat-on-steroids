# Code checkpoint PR review fixes — 21 October 2026

## Scope

Follow-up to [PR #1443](https://github.com/totec448-spec/chat-on-steroids/pull/1443), prepared
from head `6f64055f8662cb6a8a4a57f9ad02edab0e8399c8`. This addresses Maximapple's 19 October
review findings for a successful turn checkpoint evicted from the visible ledger and file/folder
path swaps during Restore all. The optional diff-read race is unchanged.

Successful session/turn keys now have a separate FIFO fence capped at 512 entries, independent of
the 20-entry checkpoint ledger. A later patch in that turn cannot create a misleading mid-turn
checkpoint after its visible entry is evicted.

Restore preflight identifies file/folder conflicts at each selected path and its ancestors. It
excludes the entire conflicting path group from confirmation and reports each excluded path with
reason `conflict`. No conflicting file or folder is removed; the Review toast explains the skipped
paths. Other selected files can still restore normally.

## Validation

- `npx vitest run test/code-checkpoints.test.ts test/renderer-file-panel.test.ts` — 71 passed,
  1 skipped.
- `npm run typecheck`, `npm run verify:notices`, and Electron module resolution — passed.
- `npm run build` — passed; Vite emitted existing dynamic/static import chunk warnings.
- All renderer locale JSON files parsed successfully.
- `git diff --check` — clean.
- `npm run verify` stopped at `verify:privacy`: existing ancestor commits
  `9e27c0fafc20bf2c81509844d5f92868678b4168` and `03acfbaad9d753d09487761e97cc1eade8eb8b22`
  use non-noreply author emails. No history was rewritten.
- Remaining broad Vitest phase: 9,508 passed, 4 failed, 104 skipped. Three failures were
  `ENOSPC` while parallel tests created 512 MiB–1 GiB fixtures; rerunning those three suites
  serially passed 14/14. The fourth failure, in `test/update.test.ts`, reproduced alone:
  the download entered `failed` before the test observed `downloading`.
- Serialized computer/shutdown tests — 28/28 passed.
- `npm run verify:ui` — 47/55 passed. The eight failing checks were
  `verify-cos-sign-in` (fixture certificate generation), `verify-goal-progress`
  (`UnknownVizError`), `verify-history-scroll` (scroll-drift assertion),
  `verify-inline-recorded-diffs` (viewport timeout), `verify-round-subagents`,
  `verify-settings-focus`, `verify-setup-guide` (timeout), and `verify-update-readiness`
  (viewport timeout). These checks do not exercise the changed checkpoint paths.
- Environment: Node 24.12.0; `npm ci` completed with engine warnings for several dependencies
  requiring Node 24.15.0 or newer.

The checkpoint and Review-panel regression suites, typecheck, build and notices checks pass.
The repository privacy gate and unrelated broad/update/UI checks are not fully green.
