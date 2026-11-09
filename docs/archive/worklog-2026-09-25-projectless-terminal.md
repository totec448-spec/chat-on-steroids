# Projectless workspace terminal

- Reproduced the first wrong boundary: the renderer refused to create a tab without a
  selected local project, even though the main-process PTY owner can use a fixed cwd.
- A new tab now captures either the selected project's canonical workspace or, when
  projectless, Electron's OS home path supplied by main. The renderer can send only a
  project id or null, never an arbitrary cwd. An invalid selected project remains an
  error rather than falling back. Command capability still gates spawn and input.
- Existing tabs keep their original cwd when project selection changes. Closing a tab
  still retires its PTY; hiding a dock retains it. No new IPC channel or permission.
- Checked: typecheck, focused Vitest (11 tests), and isolated Electron/actual PTY
  acceptance, including a projectless PowerShell, project-scoped PowerShell, terminal
  input and closed-process rejection. `npm run build` passed. `npm run verify` passed
  privacy, notices and typecheck, then reported failures in Windows UIA, plugin-manager
  and MCP suites outside the changed terminal tests; the broad run was stopped
  before a complete summary. This does not prove the installed EXE behavior.
