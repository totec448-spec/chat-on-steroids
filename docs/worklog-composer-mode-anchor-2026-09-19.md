# Composer mode menu anchor — 2026-09-19

## Problem

The Goal/Loop options popover was centered on the whole mode trigger. Because that trigger grows
from the 36 px settings icon into a variable-width mode pill, the popover moved horizontally when
the selected mode changed.

## Change

- Anchor the popover to the fixed center of the 36 px mode-icon slot (`18px`).
- Keep its existing centered placement and motion origin around that stable point.
- Add DOM/CSS coverage and a real Chromium geometry check across Off, Goal, and a wider combined
  label.

## Validation

- `npm test -- --run test/renderer-layout.test.ts` — 46/46 passed.
- `npx electron scripts/verify-panel-motion.cjs` — passed; Off, Goal, and `Loop + Plan`
  produced different trigger widths with the same popover position and icon anchor.
- `npm run typecheck` — passed.
- `npm run build` — passed (existing Vite dynamic/static import warnings only).
