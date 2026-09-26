# Workspace terminal resize — 2026-09-20

## Problem

Dragging the terminal separator inherited the shell's 220 ms panel-toggle transition. Every
pointer movement restarted that transition, while `ResizeObserver` fitted xterm and sent another
PTY resize for each intermediate frame. On Windows, those repeated ConPTY redraws could duplicate
the visible prompt and leave transient dark bands in the terminal canvas.

## Repair

- Manual terminal resize now disables the panel-toggle transition for the duration of pointer
  custody.
- xterm fitting is coalesced to one animation-frame callback. During a manual drag the local
  canvas follows the panel, while the PTY receives one final grid size after release.
- Opening/reopening keeps its upward motion, but intermediate animation frames no longer resize
  ConPTY; the settled grid is synchronized once at the transition boundary.
- The main-process terminal owner records its current rows and columns and ignores duplicate
  resize requests.
- The real Electron/PTY verifier performs a multi-step pointer drag, requires exactly one PTY
  resize, checks that xterm fills the terminal content box, and confirms the drag state retires.

## Validation

- `npm run typecheck`
- `npx vitest run test/workspace-terminal.test.ts test/renderer-layout.test.ts`: 54 passed.
- `electron scripts/verify-workspace-terminal.cjs`: real PowerShell/ConPTY smoke passed;
  opening emitted one resize, the 24-step drag emitted one final resize, and xterm filled the
  terminal content box within one CSS pixel.
- `npm run build`
- `npm run verify`: 5,623 passed / 44 skipped, then shutdown 6/6.
- Impeccable detector found no issue in the changed terminal selectors. Its sole warning was an
  unrelated pre-existing File panel border at `styles.css:3583`.
