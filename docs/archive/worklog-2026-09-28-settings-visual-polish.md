# Settings and visual polish

## Scope

Dedicated branch based on upstream main 677d35d (including #543 send-model Usage
proof and #544 routed helper cleanup). #545 was still open and changes release
notes/bridge diagnostics, not this visual surface. Windows Pets remains in #537.

- Port fork Settings presentation, retaining upstream controls, handlers and richer
  Appearance preview. Move page rules to settings.css instead of layering overrides.
- Fix rounded hover clipping, profile-menu sizing, folder spacing, Setup rows,
  Agents & automation search/section grouping, robot icon and Back to chat control.
- Usage: compact exact message counts beside the weekday filter; preserve reported
  quotas as distinct rows, Refresh behavior and estimation calculations. Use a stable
  52-week calendar, twelve month labels and an aligned legend; separate model/day
  costs, restore the cost caption under its heading, and remove excess section space.
- Use centered disclosure geometry across Settings, chat, Files and pickers; retain
  Phosphor for action icons. Include library/popover/navigation motion with reduced
  motion support, without replaying the sidebar reveal on library-to-chat navigation.
- Hide unified workspace docks and their reserved column in Settings, including
  expanded/narrow/closing states, without changing terminal or dock ownership.

## Isolation and validation

All 26 selected visual/test files match the tested integration preview after line
ending normalization. No Pets, dependency, packaging, extension, main-process,
provider, persistence or delivery changes are included. The Usage calendar window
is an intentional presentation change, not a change to recorded totals or pricing.

Focused source tests, production build and isolated Chromium fixtures are run on
this extracted branch; final results are recorded in the PR. Fixtures cover all six
Settings pages, dark/light, narrow/wide and zoom, native-select focus geometry,
navigation/reduced motion and dock isolation/return. They do not claim live account
behavior. Cross-platform verification remains with CI after publication.

Final extracted-branch results: typecheck, production build and all 168 focused
tests across 12 files passed. Chromium layout, navigation and native-select focus
fixtures passed; whitespace checks passed. No new installer was made from this
branch. Previously delivered integration installer has identical visual files but
includes separate Pets work and predates the #543/#544 base update.

## CI correction

All three jobs in run 36377007444 failed the same single static-label coverage
assertion: Back to chat was absent from the catalogs after its Unicode arrow was
replaced with a separate icon. Reproduced that exact failure locally, renamed the
obsolete arrow-prefixed key and translation in all nine catalogs, and extended the
language-switch test to check the live button label and preserved icon in every
language. All 45 tests in the ten renderer translation suites then passed. This
changes translations only, not layout or behavior. The earlier 168-test selection
omitted renderer-i18n.test.ts and therefore did not cover this static-label gate.
