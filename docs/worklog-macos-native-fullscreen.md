# macOS native fullscreen

## Change

The main `BrowserWindow` explicitly set `fullscreenable: false` on every platform, which disabled
the standard macOS green-window-button fullscreen behavior. The window is now fullscreenable only
on macOS; Windows and Linux retain the previous setting.

## Validation

- `test/window-lifecycle.test.ts`: 13/13 passed, including the macOS fullscreenability regression.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- macOS arm64 unpacked package: built successfully.
- `scripts/smoke-macos-bundle.mjs arm64`: passed.
- `scripts/smoke-packaged-runtime.mjs --platform darwin --arch arm64`: passed.
- Isolated packaged-app runtime check: the main window reported fullscreenable, entered native
  fullscreen, filled the display, and restored its previous bounds after leaving fullscreen.
- `npm run verify`: 4,411 main-suite tests passed with 129 declared skips, followed by 2/2 MCP
  shutdown tests.
