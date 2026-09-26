# Chevron UI audit — 2026-09-18

## Scope

- Replaced animated font carets with one centered SVG disclosure geometry.
- Normalized disclosure state to right when closed and down when open.
- Normalized dropdown state to down when closed and up when open.
- Applied the shared indicator to sidebar groups, permissions, optional connectors,
  Setup advanced/optional sections, model and profile menus, native selects, file trees,
  sub-agent rows/history, activity groups, plugin details, runtime diagnostics and plans.
- Kept directional action arrows, such as PDF previous/next, on the existing icon system.

## Reason

The former Phosphor font glyphs rotated around a text box whose baseline and ink were not
optically centered. Their element bounds stayed put, but the visible arrow appeared to move
vertically during the animation. Native select picker icons used a separate copy of the same
font treatment, so fixing only component-level classes would have left inconsistent owners.

## Validation

- `npm run typecheck`
- `npx vitest run test/renderer-layout.test.ts test/plugins-ui.test.ts test/renderer-agent-plan.test.ts test/renderer-file-panel.test.ts test/renderer-state.test.ts test/renderer-timeline.test.ts --reporter=dot` — 308 tests
- `npx electron scripts/verify-dropdown-layout.cjs` — dark/light, 100%/150%, closed/open geometry and alignment
- `npm run build`
- `git diff --check`

The dev app was restarted from `.dev-sandbox/port-fork-delta` against the canonical
`%APPDATA%\chat-on-steroids` profile after validation.
