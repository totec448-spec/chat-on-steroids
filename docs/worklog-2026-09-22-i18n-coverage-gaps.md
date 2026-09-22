# Renderer i18n coverage gaps — 22 September 2026

PR1 closes renderer-owned localization gaps across every currently supported UI
language: Spanish, Simplified Chinese, Traditional Chinese, Japanese, Turkish and
French. The underlying defects were broader than missing catalog entries: several
renderer surfaces bypassed `t()`, some attributes copied translated text only once
and became stale after a live language switch, and fixed app-authored Goal, PDF and
connection diagnostics were still rendered as English literals.

## Changes

- Route renderer-owned copy through the existing `t()` / `ui()` ownership path
  in chat, connection diagnostics, file/PDF preview, plugins, browser preferences,
  the agent panel, work-panel resize, workspace terminal, pet and related renderer
  surfaces.
- Keep live-language attributes live, including titles, ARIA labels, editor dirty
  state, Goal controls, connection diagnostics and PDF controls.
- Localize fixed app-authored Goal error explanations while preserving dynamic
  delivery reasons, HTTP status codes and diagnostic-code wrappers.
- Localize the two app-owned PDF limit errors and PDF rendering/failure status.
- Preserve arbitrary external/runtime content as literal data: user/provider text,
  model names, paths, request IDs and unknown runtime errors are not translated.
- Bring all six renderer catalogs to the same 1,535-key union. JSON parsing,
  duplicate-key checks, numbered-placeholder parity and mojibake scans are clean.

## Validation

The seven renderer locale/Goal suites passed **34 tests**, including a final rerun
after native-language QA corrected a few awkward or untranslated connection labels.
The final focused renderer behavior audit passed **246 tests** and exposed one stale
Turkish assertion in the connection-diagnostics regression test: the catalog QA had
intentionally changed `eşlikçi tarayıcı` to `yardımcı tarayıcı`, while the test still
expected the old wording. That assertion was updated and its isolated rerun passes.
The directly affected file-panel, plugins and pet suites also pass **53 tests**.
TypeScript `typecheck`, `git diff --check` and the production `npm run build` pass on
the completed renderer changes.

The repository-wide `npm run verify` completed with **5,820 passed / 46 skipped /
3 failed**. The three failures are outside this PR's changed files and reproduced
again when run individually with one worker:

- `test/computer-browser-uia.test.ts`: Windows UIA probe reports
  `UI_ELEMENT_GONE`.
- `test/computer-windows-accessibility.test.ts`: the native accessibility probe
  reports that an unsupported action did not reject without effects.
- `test/mcp.test.ts`: parser-recovery assertion expects the English PowerShell
  text `PowerShell parsed none of the command`, while this machine emits the
  native Turkish parser error text.

No renderer/i18n production file is implicated by those three failures, and none
of their test or implementation owners were changed by this PR.

## Scope

This PR intentionally stays inside renderer localization ownership. Extension
`chrome.i18n` / `_locales` architecture and main-process/native tray or dialog
localization remain separate follow-up work. No locale preference migration,
installation, package/release, commit, push or publication is claimed here.
