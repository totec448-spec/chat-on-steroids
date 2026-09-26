# Appearance Settings UI — 2026-09-18

## Outcome

Appearance now follows the shared 940px, one-column Settings layout. The live preview, colors,
typography, language and setup profiles retain their original controls and state owners.

## Change

- Grouped Preview, Colors, Typography and Preferences under the shared Settings section headers,
  each with a short translated description.
- Moved Reset appearance to the page header, making its page-wide effect clear; the same button ID
  and reset handler remain.
- Reused the shared Settings surfaces and responsive padding. Kept the preview visually distinct
  because it represents the chosen palette rather than another settings card.
- Opened Setup profile's anchored menu below its trigger by default, right-aligned with the
  trigger; the native flip remains available when the viewport cannot fit the menu below.

## Validation

- `npm test -- --run test/renderer-layout.test.ts test/appearance.test.ts` — 45 passed.
- `npm test -- --run test/renderer-i18n.test.ts test/renderer-i18n-es.test.ts test/renderer-i18n-tw.test.ts` — 15 passed. Also supplied four missing translations for the already-present Workspace section descriptions so catalogs remain aligned.
- Electron `scripts/verify-appearance.cjs` — passed color/theme/preview, queue-and-push, reset, reload, 1400/1100/800/640-width geometry checks, and the open Setup profile menu's position at the end of Appearance's scroll.
- `npm run typecheck`, `npm run build`, `git diff --check` — passed.
- The source UI review reported no new Appearance-specific issue.
- `npm run verify` passed privacy, notices and typecheck, then the broad Vitest run reported unrelated failures in browser creation, window lifecycle, pet atlas, input startup, project successor, shell hints and desktop helper. It was stopped after those failures rather than spending more time in out-of-scope suites; the full verify gate is not green.
