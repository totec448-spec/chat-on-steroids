# Timeline scrollbar geometry — 2026-09-22

## Scope and root cause

The renderer kept about 160 history records but gave the native scrollbar only the DOM height of the currently resident page. In a 360-message Electron fixture, adding each 30-record page changed `scrollHeight` by thousands of pixels. The visible message stayed anchored, but the thumb resized and changed position at the page boundary.

## Change

The existing timeline viewport owner now projects a bounded visual extent around unloaded records. Its top/bottom CSS padding changes in the same synchronous paint that reconciles rows and restores the visible anchor. Fetching still uses the real first/last rendered row, immutable origin cursor and 30-record stages. No session storage, IPC, input, streaming, tool-call payload or Codex execution path changed. The projection is retired on selection/filter changes, when no layout is measurable, and after disclosure geometry changes. Repeated paints avoid rewriting unchanged padding.

## Evidence and remaining checks

- Typecheck and production build passed in both Mainstream and Internal Chromium.
- Focused pagination/selection tests passed in both repositories; the Internal run included three new projection tests and four renderer history cases (7 passed). The changed hunks were compared and matched exactly across repositories.
- A temporary Electron probe with 360 variable-height messages measured a constant 36,036 px scroll range and no thumb-position change during each page reconciliation. It was removed afterward.
- The existing `scripts/verify-history-scroll.cjs` stops at an 11 px pending-to-canonical-message assertion that was already failing before this change. Temporary probes past that assertion passed the remaining native history checks in both repositories, including the revised long answer; each bypass was removed afterward.
- `npm run verify` completed with exit code 0 in both repositories. Mainstream: 233 main-suite files / 5,935 tests passed, then 2 serial files / 26 tests passed. Internal Chromium: 234 main-suite files / 5,921 tests passed, then 2 serial files / 26 tests passed. Privacy, notices and typecheck also passed in each run.
- The first complete Mainstream attempt had one `renderer-state.test.ts` failure under broad-suite load (5,934 passed / 1 failed). Its exact case passed alone (1/1), and the subsequent complete `npm run verify` passed. An earlier Mainstream attempt was interrupted due to resource use; neither attempt is represented as green.
- An Internal Chromium win32-x64 NSIS installer was built after verification, and `smoke-packaged-runtime` passed on its unpacked payload. It has not been installed or visually accepted yet. Mainstream was not packaged. A visual pass with the user's real long chat remains necessary before commit/push.
