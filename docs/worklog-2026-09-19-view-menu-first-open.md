# View menu first-open response

## Root cause

The first View press synchronously paid for creation, document loading, the Phosphor font and two
compositor frames. The shell also admitted repeated presses while that same initialization was
pending, so a delayed first response looked like a swallowed click.

## Repair

- Main now owns one readiness promise covering the complete hidden menu initialization.
- The menu renderer prewarms after the shell document loads and stays detached until requested.
- Hidden prewarm waits for document and font readiness only; it never waits for animation frames,
  because Chromium may park them while a native view is detached.
- Every visible opening snapshot restarts the same 140 ms `surface-in` reveal used by the composer;
  reduced-motion preference removes the spatial entrance.
- A failed initialization is retired so a later press can create one clean renderer.
- The shell admits one toggle request at a time and shows its existing hover surface as busy.

The menu remains a narrow native `WebContentsView`; no popup, timer or second open-state owner was
added.

## Validation

- `npx vitest run test/view-menu.test.ts test/view-menu-renderer.test.ts test/window-lifecycle.test.ts` — 24/24.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `npx electron scripts/verify-view-menu.cjs` — five commands, Phosphor glyphs, state checks,
  themes and bounds passed in real Chromium.
- After removing hidden animation-frame waits, a live dev-shell CDP press opened the native menu
  on its first request in 527 ms (`aria-expanded=true`, `aria-busy=false`).
- `git diff --check` — passed.
- The full `npm run verify` reached 5,458 passing tests but returned non-zero on two unrelated
  Windows integration flakes: native window capture and a PowerShell cut-pipeline timeout. Both
  exact failed tests passed immediately when rerun alone.
