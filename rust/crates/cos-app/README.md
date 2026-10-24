# cos-app

The native Chat On Steroids app: a GPUI window and a tray icon over the Rust Core, which runs in
the same process. It replaces the Electron shell (`src/main/index.ts`, `src/renderer/index.html`).
This crate is the shell only. The chat timeline, the composer, the file panel, the terminal and
the settings forms come in later units.

## Launch contract

`cos-app` shares the launch contract of `cos-headless`:

- `--user-data-dir=<dir>` picks the profile. Without it, the app uses the default folder.
- One app runs per profile. A second launch hands its command line to the running app and exits
  0. The running app then shows its window, unless the launch says `--background`.
- `--background` starts with the tray icon and no window, as the login item does.
- With `COS_MCP_URLS_FILE` set, the Core writes the surface URLs to that file, as it does under
  `cos-headless`.
- With `COS_APP_AUTOMATION=1` set on the running app, a second launch with `--show-tray-menu`
  opens the tray menu. UI automation uses it, because nothing else can open the menu without
  clicking the notification area.

Exit codes: 0 after a quit or a forwarded launch, 1 when the profile or the Core could not be
opened.

## What the shell does

| Area | Behavior | TypeScript source |
| --- | --- | --- |
| Window | The caption is drawn in the app with native caption buttons (gpui-component `TitleBar`). The title is "Chat On Steroids". F11 toggles full screen. | `src/main/index.ts` `createWindow` |
| Placement | The window opens from `state/window-bounds.json` while that rectangle still overlaps a display, else maximized on the primary work area. Moves, resizes and maximize are saved with a 300 ms coalescing write. Minimized and full-screen geometry is never saved. | `window-layout.ts`, `trackNormalWindowBounds` |
| Close | With `ui.minimizeToTray` the window hides to the tray. Without it, closing the window quits. | `window.on('close')` |
| Theme | `ui.theme` (light or dark) and `ui.appearance` produce the same color tokens as `paletteTokens`, for the page and for the sidebar and caption. | `src/shared/appearance.ts`, `src/renderer/appearance.ts` |
| Language | `ui.language`, else the first preferred Windows UI language the app speaks, else English. Texts come from the 12 catalogs in `src/renderer/locales`. | `src/renderer/i18n.ts` |
| Sidebar | The first 200 sessions of the Core's session index, newest first, updated live. A click picks the chat. Settings navigation with the tabs `home`, `general`, `usage`, `setup`, `settings`, `appearance` and `activity`, each a placeholder page. | `index.html`, `chat.ts` `sessionRow` |
| Connection | The sidebar capsule shows the connection state with the renderer's words and colors, updated live. When disconnected it connects; otherwise it opens a small popover with Connect or Disconnect. | `main.ts` `paintState` |
| Tray | A status dot (green while connected or offline, grey otherwise), the tooltip "Chat On Steroids — status", and the menu status, Open, Connect or Disconnect, Quit. A left click opens the window. The built-in browser's Show/Hide item is gone with the built-in browser. | `refreshTray`, `tray-image.ts` |

The renderer kept the interface language in `localStorage` (`cos.ui.language`) and mirrored it
into `config.json` as `ui.language`. This app has no renderer storage, so `ui.language` is the
only place the choice lives. The config has no "system" theme: `ui.theme` is `light` or `dark`,
as in TypeScript.

## How the views read the Core

`binding::Models` replaces the TypeScript `AppState` push. Each snapshot that the Core
publishes is a GPUI entity of its own: `settings` (the config), `connection`, `bridge`,
`sessions` (the session index, and whether restore has ended), `chat_models` and `usage`.
The task that follows the snapshot's `watch` is the only writer of its entity. A view observes
only the entities it reads, so a usage change never repaints the session list.

`binding::Timeline` follows one open chat. It reads the newest 30 events when the chat opens,
then reads a delta from its cursor after each append that the session store broadcasts. It
merges the delta as `mergeDetailDelta` does (`timeline::TimelinePage`). Dropping the entity
stops the follow task.

Nothing polls. The UI thread never waits on the Core: reads and connect or disconnect run on
the Core runtime through `AppCore::spawn`, and a GPUI task awaits the result.

Until the timeline and settings views arrive, the chat page shows what the models hold: the
chat count, the connection, the browser bridge and the picked chat's page. Clicking a session
row picks it. The connection popover shows the browser row with the renderer's words.

GPUI's `Window::activate_window` presses Alt with `SendInput` to win the foreground. This app
never calls it. It shows its window with `ShowWindowAsync` and `SetForegroundWindow`, and a
second launch first calls `AllowSetForegroundWindow` so the running app may take the
foreground.

## How it is proven

- `tests/oracle.rs` compares the token, placement, caption-color and tray-image ports with what
  the TypeScript modules compute for the same inputs. `tools/oracle.mjs` records
  `tests/oracle.json` by importing the TypeScript sources with Node's type stripping. To record
  again, from the repository root: `node rust/crates/cos-app/tools/oracle.mjs`.
- `tests/i18n.rs` checks the shipped catalogs, `t` and `systemLanguage` with the cases of
  `test/renderer-i18n.test.ts`.
- `tests/status.rs` checks the capsule, tray and browser-row wording for every state.
- `tests/timeline.rs` checks the timeline page's delta merge, with a tool call from the `base`
  corpus.
- `tools/binding-proof.mjs` drives a real window through `ui-driver` and checks each model
  against the control API (see `tools/README.md`).

The tools drive the real app from outside. They touch only windows owned by the app's pid.

| Tool | Use |
| --- | --- |
| `tools/bench.mjs` | Cold start, measured the way `scripts/bench.mjs` measures Electron: spawn to a visible window, to `/v1/health`, and to a Core `tools/list`, then memory and process count after 10 s idle. `--keep` launches one instance and leaves it running. |
| `tools/shot.ps1` | Screenshot of the app's own windows through `PrintWindow`. |
| `tools/ui-driver.rs` | The UI driver (`cargo build --release -p cos-app --example ui-driver`): tree, UIA actions, WGC screenshots and keys gated on the foreground window. See `tools/README.md`. |
| `tools/binding-proof.mjs` | The live-model proof through the driver. |
| `tools/uia.ps1` | The UI Automation tree of the app's windows. |
| `tools/drive.ps1` | UI Automation actions on the app's windows: close, invoke, move, window state, the tray menu pick, and F11 only while the app's window is in front. |
| `tools/mcp-call.mjs` | One Core tool call through the URLs file, to create live sessions. |
