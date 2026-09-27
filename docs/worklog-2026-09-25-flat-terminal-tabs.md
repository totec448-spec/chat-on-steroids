# Flat right-dock terminal tabs

- Root cause: the right dock owned a singleton Terminal tool tab while the terminal
  view owned a second visible tab bar. The outer tab's X only hid the view; the
  inner X closed a PTY, so two adjacent-looking close actions meant different things.
- The right dock now owns selection/order for each shell tab alongside Files, Review
  and Sub-agents. The terminal view retains PTY, output and fit ownership and
  projects its tab identity/title/exit state to the dock; it does not draw its
  own bar on the right. The bottom terminal keeps its existing bar and controls.
- Right `+` → Terminal creates a new shell tab. The quick action and shortcut
  select the last right shell or create one if none exists. Closing a shell tab
  retires its exact process; toggling the right panel does not.
- No new IPC, persisted process state or permissions. Existing project cwd and
  Command gates remain with the main-process terminal owner.
- Checked on the feature branch: typecheck, 12 focused Vitest cases, production
  bundle, and isolated Electron/actual PowerShell acceptance. The Electron test
  covered two right shell tabs, per-tab close/PTY retirement, right toggle
  continuity, last-tab empty shortcuts, the unchanged bottom panel, and sizing.
  `npm run verify` passed privacy/notices/typecheck but reported Windows UIA and
  MCP failures outside this dock change; it was stopped before a full summary.
