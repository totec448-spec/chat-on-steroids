# Right work-panel motion — 2026-09-19

## Scope

Reviewed only the open/close motion of the right-side Files and Sub-agents panels. The
Terminal motion was retained as the known-good reference.

## Root cause and repair

The closed chat grid represented its right track as `minmax(0, 0px)`, while the open
state resolved to a bare pixel width. Chromium cannot interpolate grid tracks with those
different shapes, so the layout change was discrete even though a 220 ms transition and
content animation were present.

The open state now remains `minmax(0, <width>)`. This makes the grid transition
interpolation-compatible without adding another timer, state machine or animation owner.
Files and Sub-agents keep their existing shared width, responsive behavior, content
animation and reduced-motion handling. Terminal code and styling were not changed.

## Validation

- `npm test -- --run test/renderer-layout.test.ts test/panel-motion.test.ts test/renderer-file-panel.test.ts` — 85 passed.
- `npm run typecheck` — passed.
- `git diff --check` — passed.
- Impeccable detector — the edited stylesheet retains one pre-existing `side-tab`
  thick-border finding outside this task; no new finding was introduced by this change.
- Mainstream Electron dev started successfully against the canonical app profile for live
  visual inspection.

The same product-owned CSS and regression test were applied to the Mainstream and Internal
Chromium repositories; only the Internal repository's existing browser-specific comment
remains different.

## Release polish

- Kept the Files toolbar in one row during horizontal resize. Refresh no longer owns a
  separate auto-margin slot; it sits with the other actions, while every action label remains
  visible in a horizontally scrollable strip when the panel becomes narrow.
- Raised the shared Files/Sub-agents resize floor to 420 px, preventing a normal drag from
  compressing the Files toolbar into its controls.
- Made that same 420 px width the default for both Files and Sub-agents; a persisted manual
  width still wins until the user resets it.
- Restored the Settings gear's standard sidebar hover surface without changing its selected
  state.
- Switched the composer Stop glyph from regular Phosphor to the matching filled Phosphor
  variant while leaving the Send arrow and stop behavior unchanged.
- Final focused validation after this pass: 279 layout, Files, panel-motion and composer
  tests passed in each repository; typecheck and `git diff --check` also passed.
