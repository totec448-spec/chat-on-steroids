# macOS sidebar toggle chrome

## Change

The renderer's custom top bar occupied a full-width row below the native macOS title bar and
carried both the sidebar toggle and a custom **View** menu. macOS now uses Electron's native
`hiddenInset` title-bar style, so the web content fills the traffic-light area and the sidebar
visually owns the full left edge from top to bottom. The View menu is hidden on macOS and the
sidebar toggle sits immediately after the native traffic lights, inside a transparent draggable
sidebar chrome region. Its center line is aligned with the traffic lights, and expanding/collapsing
uses a 220ms eased grid slide with a subtle sidebar translate/fade instead of instantly removing the
sidebar. Native fullscreen state is also observed: when macOS hides the traffic lights, the toggle
slides from its normal `x=88` position to `x=14` at the upper-left, then slides back when fullscreen
ends. That motion uses the same 220ms easing and follows the existing reduced-motion override.
Windows and Linux retain the existing top bar and View menu.

## Validation

- `test/window-lifecycle.test.ts`, `test/renderer-layout.test.ts` and
  `test/sidebar-resize.test.ts`: 54/54 passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- `npm run verify`: 4,412 main-suite tests passed with 129 declared skips, followed by 2/2 MCP
  shutdown tests.
- macOS arm64 unpacked `.app`: packaged and ad-hoc sealed successfully.
- Isolated packaged macOS runtime: the renderer filled the complete native window height
  (`830 CSS px × 1.3 device scale = 1079 px`, matching the `1079 px` CGWindow height), proving
  that no separate native title-bar row remained above the web content. The expanded sidebar began
  at `y=0`; the transparent drag region covered the sidebar width; the toggle was at `x≈88, y≈7`;
  the View menu computed to `display: none`. After collapse the same toggle position was retained
  and the header reserved the traffic-light/toggle chrome instead of painting beneath it.
- Combined local fullscreen preview: entering native fullscreen moved the toggle through measured
  intermediate positions (`x≈88 → 46.6 → 26.1 → 21.1 → 16.2 → 14.5 → 14`) rather than jumping,
  and leaving fullscreen restored `x≈88`. The standalone PR branch remains `fullscreenable: false`,
  so this PR does not depend on the separate native-fullscreen contribution.
