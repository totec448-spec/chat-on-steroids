# Composer Plan + automation mix

## Problem

Selecting Plan before `/goal` or `/loop` removed Plan, while selecting Goal/Loop before Plan
produced the intended combined mode. The combined label was derived correctly, but the slash
picker projected the consumed control through an ordinary `input` event. When that projection
left an empty textarea, the Plan owner interpreted it as the user clearing the task.

## Change

- `skills.ts` now marks only consumed composer controls with a local semantic event detail.
- `chat.ts` ignores that projection for Plan cancellation while retaining the existing behavior
  for real edits, including clearing the complete task during planner generation.
- Renderer regressions cover Plan → Goal, Plan → Loop, the reverse order, explicit clearing, and
  the durable send payload containing the generated workflow plus the selected automation mode.

No new mode ledger or durable state was added. Plan remains draft-owned; Goal/Loop remains the
session/input automation owner; the combined pill remains presentation of those two facts.

## Validation

- `npm run typecheck` — passed in Mainstream and Internal Chromium.
- Focused renderer regressions — 4 passed in both repositories.
- `renderer-timeline`, `renderer-skills`, and `session-input` suites — 388 passed in Mainstream.
- `npm run verify` — 224 files / 5,577 tests passed, 4 files / 44 tests skipped; shutdown suite
  6/6 passed. Privacy, notices, native-source, Electron and typecheck gates passed.
- Impeccable detector on the changed Mainstream renderer/test targets — no findings.
- `git diff --check` — passed.

No live Electron smoke was claimed in this change.
