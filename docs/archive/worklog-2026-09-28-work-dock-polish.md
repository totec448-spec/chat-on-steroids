# Work dock motion and polish

Base: `4e51a04` (upstream 2.1.20 with #582 and #583), branch `ui/work-dock-polish`.

## Findings

Measured per frame in real Electron (1440×900) before changing anything:

- The chat grid declared a 220ms `grid-template-columns` transition, but it never ran. The
  open track `var(--work-panel-width, minmax(340px, 42%))` does not interpolate with the
  closed `minmax(0, 0px)`, so the chat jumped 1171→679px in one frame, with or without a
  stored panel width.
- Opening showed a 1px sliver for two frames, then the full panel fading from 0.55.
- Closing collapsed the track first; the 170ms exit fade then ran on a 1px sliver, so the
  panel effectively vanished.
- Expand/restore and tab switches had no motion.
- The bottom dock adds a fifth `.app` row only while open, so its track could not interpolate;
  it popped in with a 14px lift and a 0.55 opacity start.

## Change

Renderer only. `moveWorkDock` (`panel-motion.ts`) reads the resolved pixel tracks before and
after a layout change and animates between them with WAAPI, so every track form moves: the
default percentage, a stored width and the expanded layout. CSS still owns the resting layout.

- Open/close: both docks are drawers. The content keeps its resting size (minus the dock's
  1px border, so nothing refits at the end) on the leading edge and slides whole; a terminal or
  editor lays out once. Open 320ms `cubic-bezier(.22, 1, .36, 1)`, close 240ms
  `cubic-bezier(.4, 0, .2, 1)`. The bottom dock's open-only row is animated from a trailing 0.
- The outgoing tool (right) or terminal (bottom) stays mounted until the drawer has left.
- Expand/restore: the chat keeps its readable width and fades under the dock instead of
  wrapping into a sliver; the dock content resizes like a divider drag.
- Interruptions continue from the current frame; a reopen during an exit keeps the tool.
- Tab switches settle in with a 160ms fade.
- Reduced motion, narrow windows (≤850px) and hidden screens change layout immediately.
- The dead CSS transition and the old `showSlidingPanel`/`hideSlidingPanel` were removed.

## Dock `+` menus

- Both `+` menus (right dock and bottom terminal) use the composer menus' motion, mirrored for
  a menu below its button: enter `surface-in`-style 140ms, leave 120ms while
  `::details-content` keeps it painted; the trigger keeps its hover state while open.
- Pre-existing: the menu was anchored by its right edge to a `+` that follows the last tab, so
  with one tab it opened over the sidebar. It is now anchor-positioned (`position-area: bottom
  span-right`, `flip-inline`) and `position: fixed`: the 36px bar was too short a containing
  block for any fallback to fit. It opens toward the interior and flips at the window edge;
  `elementFromPoint` confirms it still receives pointer input above the tool.

## Bottom dock resize

- Pre-existing: the `.terminal-resize` handle was absolutely positioned against the page (the
  bottom dock was `position: static`), so it sat under the top bar at y = -4 and the dock could
  not be resized. It is now anchored to the dock and raised above the terminal bar (z-index 10),
  overlapping only the bar's top padding.
- Dragging keeps the resize cursor and edge highlight for the whole drag, like the right dock.
  Existing clamping (130px to 65% of the window), keyboard steps and the saved height apply.

## Tab pills and reordering

- Pre-existing: a right-dock tab's title was a bare text node in a flex button, so it could not
  truncate and ran under the close control. Titles now sit in `.tab-label` and truncate; the
  right-dock and bottom-terminal pills share one layout (icon, label, 20px close, 28px high,
  84–200px wide) and shrink before the strip scrolls. Bottom tabs gained the terminal icon.
- Both strips reorder by pointer drag (`tab-reorder.ts`): the dragged pill follows the pointer
  within the strip, neighbours slide aside, and on release the owner commits the order (the
  right dock's `opened`, the bottom terminal's tab map) and the pill settles into its slot. The
  close control never starts a drag, and the click that ends a drag does not also activate.
- Ctrl+Shift+Left/Right moves the focused tab one place.
- Pre-existing: every selection rebuilt all pills (new nodes per click), which reset hover and
  focus and repainted the strip. Selection now updates pills in place; only a change of tabs,
  order or titles rebuilds. A tab-switch content fade added earlier in this branch started at
  opacity 0 and read as a blink; it was removed.

## Icons

- Header dock controls: the shared 17px glyph in a 15px box sat at x.5 and blurred, worst on the
  rotated/mirrored `sidebar-simple`. They now draw upright filled half-squares
  (`square-half`, `square-half-bottom`) and `corners-out/in` at 18px on whole pixels; at 125%
  scaling, where one-pixel strokes cannot land on the grid, the filled halves keep solid edges.
- Right-dock text glyphs replaced with the Phosphor vocabulary: Sub-agents back (`←` → `i-back`,
  as Files uses), PDF previous/next (`‹ ›` → carets) and zoom (`− +` → magnifying glasses), and
  the branch/rename arrows (`→` → `arrow-right`).
- Review's next-edited-file control drew the disclosure caret beside a previous arrow; it now
  uses `arrow-right`, and the unused `i-chev` vocabulary entry is removed.

## Toolbar icon controls

- An Electron audit measured every icon button in both docks and the header. The dock toolbar
  controls (+, hide bottom panel, refresh) drew a 17px glyph in a 15px box: refresh sat 1.5px and
  hide 0.5px off centre, hide was 26px beside a 28px +, and the bottom bar's + had no hover (its
  rule was scoped to the right dock's bar). They now share one 28px square with a 16px glyph on
  whole pixels, grid centring and one hover; all measure 0/0 offset.

## Branch compare menu

- The Files/Review "Working tree" compare menu (with its branch search) appeared and vanished
  without motion. It now enters with the dock menus' 140ms drop and leaves with a 120ms fade
  before removal; its logical state still clears immediately.

## Validation

- Typecheck passed. `panel-motion`, `renderer-workspace-docks`, `renderer-layout` and
  `workspace-terminal`: 66 passed, including cases for pixel tracks, drawer size, exit
  retirement, interruption, handover, the bottom dock's open-only row, reduced motion and the
  bottom resize handle; `tab-reorder`: 4 more for slot choice, neighbour shift, clamping, close
  control, single tab, no-op release and the keyboard mapping.
- Icon font, Files, Sub-agents and layout suites: 131 passed after the icon changes.
- Real Electron: pill nodes keep their identity across a tab click and the dock body stays at
  opacity 1; header icon boxes sit at whole pixels (checked at 1× and a forced 1.25 scale).
- Real Electron: three bottom pills measured 140×28 with the label ending 6px before the close;
  a 40-character right-dock title truncated inside a 200px pill; a mouse drag moved the first
  bottom tab one place with its neighbour shifted by exactly one slot.
- Real Electron: dragging the handle with mouse events resized 250→400px in 30px steps and saved
  400; the `+` menu opened inside the dock near both edges.
- A temporary Electron probe (not committed) sampled every frame of right open, expand,
  restore, close, an interrupted reopen, and bottom open/close; it captured frozen frames at
  20/50/80%.
- `verify-workspace-terminal.cjs` now waits for the bottom terminal to hide after the exit (it
  asserted immediate hiding). It and `verify-pr-workspace.cjs` (line 285) then fail exactly as on
  untouched `d0d4c85` (the terminal script waits for a `powershell` tab title); every dock step
  before those points passes.
- The full suite was not run locally.
