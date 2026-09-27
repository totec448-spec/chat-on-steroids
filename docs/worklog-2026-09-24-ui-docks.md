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

- Extended the single dock owner to a right tool frame and bottom terminal frame. Files
  and Sub-agents open on the right; the bottom frame owns only Terminal. Right terminal
  sessions appear in the dock's single tab strip, while the bottom has its own terminal
  tabs. Both keep live PTYs when their panel is hidden; closing a tab ends that PTY.
- Moved bottom height control to the dock frame. Ctrl+backtick toggles bottom Terminal;
  Ctrl+Shift+2/3/4 open right Terminal/Files/Sub-agents. Files drafts survive a hidden
  panel while its watches retire. A projectless terminal starts in the main-owned home
  directory without weakening exact project validation for selected projects.
- Checks: typecheck, focused renderer/terminal suites, production renderer build and
  isolated Electron terminal scenario. Electron exercised hidden-panel continuity,
  independent right and bottom PTYs, additional tabs, Ctrl+C, exit and sizing.
  The Electron fixture now compares the detached connection popover to the sidebar
  surface under a non-translucent test theme; the old assertion incorrectly equated
  sidebar and page background colors.

### PR preparation — terminal and Files ownership

- Corrected the dock controls and placement to the final right-tools/bottom-Terminal
  contract. Removed nested right terminal tabs, allowed projectless terminal creation
  through the existing fixed IPC, and kept Files actions horizontally scrollable with
  Refresh fixed at the edge. Dock tabs retain keyboard focus and hover as one capsule.
- Typecheck, 90 focused renderer/terminal tests, the real Electron PowerShell fixture,
  and the isolated Chromium workspace fixture passed. The latter checks Files drafts,
  PDF/editor views and responsive layouts; no provider or installed app was involved.

### CI follow-up — terminal test doubles

- Upstream PR #489 failed on Linux, Windows and macOS with the same
  `rightWorkspaceTerminal?.tabs is not a function` error. Three renderer suites
  still mocked the pre-dock terminal shape. Updated those test doubles to expose
  the terminal tab methods used by the dock; application code is unchanged.
- Typecheck and production build passed. The three focused suites passed 257 of
  258 tests together; one unrelated renderer-state test hit its 30-second limit
  under that combined run, then passed alone (51 other tests skipped). A full
  CI pass is not claimed until the upstream checks rerun.
- After the test-double fix, upstream Linux and macOS checks passed. Windows
  passed 6,097 tests but failed one unrelated `bridge.test.ts` unattributed
  recovery assertion; that exact case passed alone on Windows. The contributor
  account cannot rerun an upstream Actions job directly, so a documentation
  update triggers a fresh PR check without changing bridge behavior.
