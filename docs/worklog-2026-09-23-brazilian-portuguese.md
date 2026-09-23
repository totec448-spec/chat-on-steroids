# Brazilian Portuguese UI locale — 23 September 2026

Added `pt-BR` to the existing renderer language preference and localization path. Setup and Appearance expose the native name `Português (Brasil)`, and selecting it persists through the existing `cos.ui.language` preference. App-owned renderer labels use the catalog; authored drafts, provider text and unknown provider errors remain literal.

The dedicated regression suite checks complete catalog key coverage, duplicate keys, nonempty translations and numbered placeholders. It exercises Setup and Appearance synchronization, reload persistence, invalid `pt-PT` fallback, unavailable storage, switching across every supported language, draft/focus/selection preservation, literal interpolation and known versus unknown error toasts. Existing language-switch suites include pt-BR as well.

Eight Setup flags exceeded the fixture's 330px width with the old 42px buttons. The buttons are now 37×36px with 5px horizontal padding, retaining a 24×16px SVG and the fixture's minimum 36×32px reachable target. The real Chromium fixture covers pt-BR at normal, 150% zoom and narrow window sizes, then verifies keyboard selection and preference restoration after reload.

`AGENTS.md` now lists pt-BR as supported.

## Validation

- After the three final catalog wording corrections, the six focused language suites passed again: 27 tests.
- `npm run verify` did not pass overall. Its pre-test checks passed: public-history privacy, dependency license notices, pinned native archive checks and TypeScript. The main Vitest run passed 5,763 tests, skipped 109 and failed two unrelated `write_stdin` regressions: `test/code-mode-mcp.test.ts` expected `OWNED_RESULT` but received only the initial `owner` fragment while the process was still running after 1.001 seconds; `test/mcp.test.ts` expected `echo=anon` but received only `anon` under the same condition. Both exact cases were rerun individually in a clean detached worktree at `origin/main` (`750fad9378a0cf9e37791916b11f7ed9add645dd`) and failed the same way, confirming these failures are present on the baseline. These paths are outside the pt-BR changes.
- The final `computer.test.ts` / `mcp-shutdown.test.ts` command, which `verify` skipped after the preceding failure, passed separately: 6 tests passed and 20 were skipped.
- `npm run build`: passed again after the final catalog wording corrections. Vite emitted notices about modules reached through both static and dynamic imports, with no build errors.
- `./node_modules/.bin/electron scripts/verify-setup-guide.cjs`: passed 108 header/content layouts, native keyboard selection and persistence, modal/Escape/focus, and optional disclosure checks.
- `git diff --check`: passed.
- Inspected generated pt-BR Setup header screenshots at normal size, 150% zoom and narrow width. The flag row fits the compact header, the Brazil SVG remains legible, and the title/help text do not overlap it. Artifacts are in the ignored `outputs/setup-guide/` directory: `pt-BR-1100-1-header.png`, `pt-BR-1100-1.5-header.png`, and `pt-BR-640-1-header.png`.
