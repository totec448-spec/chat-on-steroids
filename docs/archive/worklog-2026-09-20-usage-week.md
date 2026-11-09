# Verified message counts by chosen week start

## Result

Usage now starts with a compact Verified messages section: exact GPT-5.6 and GPT-6
counts, one button cycling the start weekday, and the precise local date/time range.
Monday is the default; `cos.usage.weekStart` preserves the choice. Selecting Saturday
on Monday counts from the immediately preceding Saturday at local midnight through
the displayed snapshot time. Selecting today's weekday begins today. No budget or
provider-reset controls were added, following the user's simplified request.

## Evidence and ownership

The existing canonical delivered native message owns verified model selection.
Counts use its provider-authored timestamp when present, otherwise the original
delivery time. Injected `input:` messages, unconfirmed offers, missing/unknown model
evidence, invalid timestamps and future sends are excluded. Native message identity
deduplicates observations and copied history; conflicting evidence abstains.
Token attribution's legacy assumptions and current picker state are never count proof.
Counts cover retained, verifiable recordings and are not provider balances.

Usage cache version 9 retains minimal native ID/model/time facts alongside existing
token totals. Time-window changes reuse that cache. IPC returns only seven local
calendar days of counts and the snapshot end time; weekday clicks are local display
changes with no additional transcript read. Calendar arithmetic handles DST.
English, Spanish, Simplified Chinese, Traditional Chinese and Japanese labels use the
existing UI translation bindings. Numeric counts are not compacted or rounded.

## Validation

- Focused Usage, calendar and language tests: 93 passed across seven files.
- `npm run verify`: passed, including privacy/notices, typecheck, 5,592 main-suite
  tests and six separately run shutdown tests; 45 tests were skipped by their existing
  platform/live-test conditions.
- `npm run build`: passed for main, preload and renderer. Vite retained its existing
  informational mixed static/dynamic import notices.
- `node node_modules/electron/cli.js scripts/verify-usage-week.cjs`: passed. Real
  Chromium exercised exact counts, native Space-key activation, saved choice, dark
  layout, and narrow Japanese light layout at 125% zoom. A one-pixel layout tolerance
  accounts for Chromium's subpixel rectangle rounding.
- Reviewed both screenshots under ignored `outputs/usage-weekly/`.
- `git diff --check`: passed.

Implementation, tests, build and isolated Chromium evidence are complete. This work
does not claim installed-payload or signed-in provider acceptance. The running app was
not replaced or restarted; no package, release, commit or push was performed.
