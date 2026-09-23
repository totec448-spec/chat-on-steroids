# European Portuguese UI — 23 September 2026

The app now offers European Portuguese (`pt-PT`) through the existing renderer
localization owner. The change follows the reviewed French integration on `origin/main`:
there is no new locale framework, preference store or background process.

`src/renderer/i18n.ts` registers the `pt-PT` catalog under the existing
`cos.ui.language` preference. Appearance exposes `Português (Portugal)` in the named
language selector, while Setup exposes the same locale as a Portugal flag with the
native language name in its tooltip and accessible label. Both controls continue to
project one saved preference, and the document language becomes `pt-PT` immediately
when selected.

The Portuguese catalog covers the same current source-key set as the complete French
and Turkish catalogs. Wording is written for Portugal rather than Brazilian Portuguese;
product names, code/tool identifiers, authored text and provider text remain literal,
and numbered interpolation arguments are preserved exactly.

The renderer also had a small set of app-authored labels and success toasts that already
had catalog entries but bypassed `t()`. Those call sites now use the existing translation
owner, so language changes also apply to project removal, Goal controls, API-key feedback,
attachment-limit feedback, activity copy, handoff/swarm actions and browser-companion
feedback. Unknown/runtime detail strings keep their existing literal fallback behavior.

Regression coverage adds a dedicated Portuguese suite for catalog completeness,
placeholder preservation, both selectors, persistence, draft/focus preservation,
literal interpolation arguments, storage failure and translated app-owned errors.
The neighboring all-language suites include `pt-PT`, and the real Electron Setup
fixture includes Portuguese at normal, enlarged and narrow layouts plus keyboard
selection and reload persistence.

## Validation

The final catalog has 1,452 keys, exactly matching the source-key union on `origin/main`:
no missing, extra, duplicate or empty entries, and every numbered `{n}` argument matches
its English source. A targeted vocabulary scan found none of the common Brazilian forms
blocked for this translation (`arquivo`, `tela`, `senha`, `salvar`, `excluir`,
`gerenciar`, `compartilhar`, `baixar`, `configurações`, `usuário` and variants).

All seven renderer language suites passed (33 tests), including the new Portuguese suite.
The renderer timeline/layout/usage regression set passed 237 tests. TypeScript type checking
passed. `npm run verify` passed 5,755 ordinary tests with 118 existing skips, then the
serialized shutdown/native stage passed 6 tests with 20 platform skips. The production
`npm run build` passed; Vite emitted only the existing dynamic/static-import chunk warnings.

The real Electron Setup fixture wrote results for 108 setup/header layouts. Its 18 Portuguese
cases cover 1100 px dark, 1100 px at 150% light and 640 px dark; every case reported no
overflow, visible images, fitting labels and the expected translated captions, with the
`pt-PT` flag selected and reachable. The fixture writes `results.json` only after its native
keyboard switching, reload persistence, modal/Escape/focus and optional-disclosure assertions,
so those checks also completed. The enlarged light and narrow dark Portuguese headers were
inspected visually and showed no clipping or overlap. The Electron wrapper was interrupted
after these outputs had been written, so the recorded fixture assertions and screenshots are
the acceptance evidence rather than a clean wrapper process exit.
