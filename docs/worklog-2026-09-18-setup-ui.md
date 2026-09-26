# Setup Settings UI — 2026-09-18

## Outcome

Setup now uses the same 940px reading canvas as the other Settings pages. Its six-step
connection guide remains one ordered flow, with individual step surfaces, clearer state markers, larger screenshots,
and responsive language controls. The existing state, credentials, tunnel, connector and
browser-pairing owners were not changed.

## Change

- Aligned the heading, guide and advanced disclosure to the Settings layout.
- Moved responsive page padding from the inner sheet to the Setup panel so the actual
  content canvas reaches 940px on wide windows, matching the other Settings pages.
- Gave each step its own card after live feedback that the single surface felt crowded.
  Replaced the bright filled completion circles with restrained green checks, kept
  numbers for incomplete steps and retained the existing verified-completion checks.
- Flattened secondary content inside steps so connector details and the permissions
  reminder do not create cards inside cards.
- Increased instruction and screenshot legibility, preserved the optional Desktop
  disclosure, and removed horizontal overflow at narrow widths.
- Added top-of-page geometry, separate-card and state-marker checks to the existing
  Chromium screenshot fixture. It now loads the production icon font and also checks
  translated callouts, modal behavior and optional content.

## Validation

- Electron `scripts/verify-setup-guide.cjs`: 25 screenshot layouts passed at 1400, 1100,
  800 and 640px, including an exact 940px wide canvas, 1.5× zoom, English and Chinese,
  dark and light themes.
- `npm test -- --run test/renderer-layout.test.ts test/renderer-i18n.test.ts
  test/renderer-i18n-es.test.ts test/renderer-i18n-tw.test.ts test/connection.test.ts`:
  76 tests passed.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.
- Inspected the live Setup page in the canonical profile. The dev was restarted from
  this worktree on port 5173; no setup action or credential change was performed.
- The full repository `npm run verify` was not rerun; a preceding broad run in this
  worktree had unrelated failing suites, as documented in the Appearance worklog.
