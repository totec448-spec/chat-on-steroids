# Reload preserves current activity and recovery

## Problem and evidence

A page reload can republish an earlier response's final message with `activeNow: true` because the page still knows its recorded request owner. An HTML revision makes the canonical upsert report a change. The recorder previously accepted that flag as terminal activity without checking whether the final could complete the current response.

The stored current turn correctly stayed open, but the bridge consumed the terminal activity verdict, removed its work grant and cancelled its recovery watch. This explains an open chat losing its activity indicator immediately after reload. The inspected session had historical final revisions and no manual-close event in that interval; a later explicit native Stop was a separate terminal event. The reload occurred before the existing ten-minute Pro silence deadline. Its five-minute countdown reveal is not an earlier reload deadline.

## Change

`src/main/session/recorder.ts` defers final-derived terminal activity until all observations in the batch have committed. It reuses `readCompletedFinal`, including the current response, canonical message ownership and any newer question or work. This is the same completion authority already used to reconcile an open turn after reload.

Historical final revisions preserve the existing activity and recovery clocks. The existing explicit Stop, tab-close and real-final paths remain in place. There is no additional timer, reload flag or persistent state.

## Verification

- Before the fix, three recorder identity variants and two HTTP bridge scenarios failed: the old final reported terminal activity and the current activity expiry became null.
- After the fix, all five original reproductions passed.
- Strengthened existing tests cover a newer question on either side of the final in one batch. Bridge scenarios check the unchanged deadline before manual reload, automatic recovery at that deadline and preservation of the confirmed reload countdown.
- `npm run verify` passed: 5,477 tests in the main run plus all 6 shutdown tests, with 45 tests skipped. Privacy, license notices, native source inventory and TypeScript checks passed. The run includes all 499 bridge, 688 content-script, 237 extension and 34 recorder-final-identity tests.
- `npm run build` passed for main, preload and renderer. Vite reported mixed static/dynamic imports in existing input and skill modules; there were no build errors.
- Local evidence: `.tmp/reload-activity-red.log`, `.tmp/reload-activity-green.log`, `.tmp/reload-activity-verify.log` and `.tmp/reload-activity-build.log`.

Only source files and regression/documentation changes are part of this work. Live session records and the running installation were not modified. Existing unrelated worktree changes were preserved.
