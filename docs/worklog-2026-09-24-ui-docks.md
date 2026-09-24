# Workspace docks — local integration log

## Part 1 — `feat/ui-dock-shell`

- Added a single renderer owner for the right dock frame, tabs, launcher, `+` menu,
  expand/restore and two top-right panel toggles. Existing Files and Sub-agents
  keep their own data and security boundaries; the existing bottom terminal keeps
  its PTY owner and receives the grouped bottom toggle.
- Hidden Files retires its watches; the dock does not create a filesystem or
  terminal IPC path. The right dock starts empty and disabled launchers cannot
  open tools without their exact project/session scope.
- Checks: `npm run typecheck`, five focused Vitest files (82 assertions), and
  `npm run build` passed. Isolated Electron terminal acceptance reached the
  appearance-color assertion after validating shell creation and terminal reuse;
  the detached connection popover reported transparent instead of the expected
  black in that fixture, so full runtime acceptance is not claimed yet.

### PR preparation — remove obsolete chat-edge toggles

- Files and Agents no longer mount legacy toggle buttons inside the chat. The dock
  derives availability from the selected project/session and remains the only
  visible control owner. Escape returns focus to the right-dock control.
- Typecheck, the focused chat regression, 36 adjacent dock/File tests, and the
  production bundle build passed. The full renderer-timeline suite was stopped
  after a long silent run; its new regression passed in isolation.

## Part 2 — `feat/ui-dock-tools`

- Extended the single dock owner to right and bottom tab frames. Files and Terminal move
  as single renderer views; Sub-agents remains right-only. File drafts and terminal PTYs
  stay with their original modules rather than being reconstructed on each placement.
- Moved bottom height control to the dock frame. The per-tool bottom shortcut retains
  Ctrl+backtick; Ctrl+Shift+2/3/4 open right Terminal/Files/Sub-agents. A hidden dock
  retires Files watches while keeping terminal processes alive.
- Checks: typecheck, focused renderer/terminal suites, production renderer build and
  isolated Electron terminal scenario. Electron exercised hidden-panel continuity,
  right↔bottom reparenting of the same live PTY, a second tab, Ctrl+C, exit and sizing.
  The Electron fixture now compares the detached connection popover to the sidebar
  surface under a non-translucent test theme; the old assertion incorrectly equated
  sidebar and page background colors.
