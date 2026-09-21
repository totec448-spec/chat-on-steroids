# Titlebar workspace controls

## Request

Move the existing Terminal, Files and Sub-agents toggles from the chat header row to the far
right of the native-style top titlebar row. Keep every existing toggle behavior unchanged.

## Change

- Added one titlebar action host after the View menu.
- Files and Sub-agents keep their existing button instances and handlers, but are mounted into
  that host instead of beside the Connect button.
- Terminal keeps its existing button instance and handlers and is prepended to the same host,
  preserving the existing left-to-right order: Terminal, Files, Sub-agents.
- The action host is hidden on Settings and Library, matching the old behavior inherited from
  the hidden chat header on those screens.
- The titlebar group is non-draggable while the surrounding titlebar remains draggable.
- Follow-up polish standardizes all three controls as icon buttons with the same 28 × 24 px box,
  14 px SVG glyph, 6 px corner radius and 4 px inter-button gap. The Sub-agents text glyph was
  replaced by a stroke-based right-panel icon from the shared sprite so it matches Terminal and Files.
- Motion follow-up adds directional transitions without changing toggle ownership: the left sidebar
  slides horizontally, Files and Sub-agents slide in/out from the right, and Terminal slides up/down.
  Programmatic swaps between Files and Sub-agents remain immediate to avoid overlapping two panes in
  the shared work slot. Reduced-motion users keep the same state changes without animation.
- Composer follow-up removes the redundant Chat options gear and its legacy popover now that Plan,
  Goal, Loop and Compact are exposed through slash commands. The existing automation/session control
  nodes remain mounted in a hidden state container because renderer logic still uses them internally,
  while the visible context meter keeps its composer position. The old Goal-dock Edit task shortcut
  that reopened the removed popover is also removed; Pause automation remains available.

## Validation

- Focused layout/sidebar/right-panel suite — 79/79 passed, including `renderer-layout` 41/41.
- `npm run typecheck` — passed.
- Gear-removal focused suite — 237/237 passed across renderer layout, slash commands and timeline behavior.
- `npm run verify` — main suite: 5,725 passed / 109 skipped; isolated shutdown suite: 6 passed / 20 skipped (`computer` is intentionally skipped on this run).
- `npm run build` — production main/preload/renderer bundle completed successfully.
- `npm run dist:mac:arm64` — macOS arm64 app, ZIP and DMG built successfully; packaged runtime smoke,
  macOS bundle smoke and `codesign --verify --deep --strict` all passed.
- `git diff --check` — passed.
