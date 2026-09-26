# Composer mode indicator - 2026-09-18

## Outcome

- The compact Chat options control exposes Goal, Loop and Plan selections made through slash completion.
- Goal/Loop and Plan retain their independent owners, so the projection can show Goal + Plan or Loop + Plan without introducing another mode ledger.
- The options icon now follows the projected state: target for Goal, circular arrows for Loop, checklist for Plan and gear when no mode is active.
- Slash-selected Compact is a removable composer pill. It calls Compact & Resume only on Send, preserves any authored message for the resumed chat and stays armed if the call is refused.
- The indicator stays inside the existing composer toolbar and keeps the options menu as its interaction target.
- The empty-chat welcome now uses the stable body + dock + composer composition viewport. Adding or wrapping Skill/action pills grows the composer without pushing the welcome upward. Its visual group sits at a responsive optical center around 43% of that viewport, above the heavier bottom composer.

## Changed

- Added the localized active-mode label and accessible description to the Chat options summary.
- Repainted it from the existing automation selection and draft plan state.
- Extended renderer and real Electron geometry coverage, including the current attachments and selected-Skills layouts.
- Added a real Electron regression for the welcome anchor with zero, one and multiple wrapped pill rows at desktop and narrow widths.
- Documented the ownership rule in `AGENTS.md`.

## Validation

- `npm run typecheck`: passed.
- Focused renderer indicator and Compact tests: 3 passed, 163 skipped by filter.
- Existing direct session-control regression: 1 passed, 165 skipped by filter.
- `test/renderer-skills.test.ts`: 11 passed.
- A full `test/renderer-timeline.test.ts` run exposed 17 stale-submit failures after the prior Send affordance change. Moving execution authority back to draft/control validation reduced this to two fixture-only click cases; both fixtures now emit the same input event as real typing and their focused rerun passed 2/2. The other 164 tests passed in the full run.
- `node scripts/verify-composer-context.cjs`: passed at 1000, 640 and 430 px with attachments, selected Skills, the active combined label and a stable empty welcome across zero, one and wrapped pill rows.
- The same geometry check now rejects an implicit second grid column and verifies the visible icon/text group stays in the 40–45% optical band.
- `test/renderer-layout.test.ts`: 38 passed in the source implementation.
- `test/renderer-skills.test.ts`: 11 passed after the welcome-layout correction.
- Edited locale JSON parsing: passed.
- `git diff --check`: passed.
- Impeccable detector completed once. Its findings are existing page-wide contrast, clipping, card, shadow, heading, live-status and side-border advisories; none point to the new mode icon or Compact pill implementation.
