# cos-companion

What the app and the browser extension exchange outside of chats (unit E2.4). It ports
`src/main/chat-models.ts`, `browser-preferences.ts`, `observeUsage` in `session/usage.ts`, the
native Project creation handshake of `projects.ts`, and the `/status`, `/models`, `/usage`,
`/settings`, `/browser/preferences`, `/diagnostics`, `/plugin-refresh` and `/project-create`
handlers of `bridge.ts`.

The bridge family `cos_bridge::families::models::Companion` is the wire layer. It reads the body
and calls the owners here. `cos-core` builds each owner once, registers the family, and hands the
UI the catalog and the usage limits as watches (`Watches::chat_models`, `Watches::usage`) and
every owner through `Domains::companion`.

## Owners

| Owner | Keeps | UI reads |
| --- | --- | --- |
| `ChatModels` | The observed catalog, in `state/chat-models.json` (`{ observedAt, models }`). The discovery request and its nonce live in memory only, so a restart never restores the authority to open a ChatGPT tab. A request ends at its two-minute deadline on its own timer. | `watch()`, `catalog()`, `request(allow_open)` |
| `UsageLimits` | The latest account snapshot. A newer one replaces it whole; stale, future and older ones are ignored. | `watch()`, then `UsageSnapshot::fresh(now)` |
| `PreferenceRequests` | One request at a time for the extension's own preferences, answered within 65 s. | `request(patch).await` |
| `Diagnostics` | The extension's latest popup-equivalent snapshot, bounded and without page text. The Core's `Domains::disconnect_browser` clears it. | `fresh(present, wake).await` |
| `ProjectCreates` | Nothing itself: the link transitions run over the projects owner's `ProjectLinks`. | none |

## Ports to owners that are not ported yet

Each port has a `No…` implementation that answers as the TypeScript app does when that owner
holds nothing. `cos-core` wires those, except where the table names what it wires instead.

| Port | Owner | With no owner |
| --- | --- | --- |
| `BrowserWork` | Recorded chats (E2.2), inputs and commands (E2.3), browser recovery | `cos-core` wires `Work`: `conversations` from the recorder, `stopTurns` and `commandIds` from the command ledger, `inputOpeningIds` and `inputs` from the outbox, handed out per browser by [`custody::Custody`]. A chat counts as having no tool call in flight and no tunnel takeover settling. Browser recovery has no owner: no repair or revival, the default tab policy, `recoveryMonitoring: false`. |
| `ProjectLinks` | Projects (`state/projects.json`) | No project: nothing pending, every page report answers 409. |
| `PluginRefreshes` | Plugin refresh ledger and publications | Nothing pending or published, every report answers 409. |
| `ChatPolicy` | Compact & Resume, workers, Goal and Loop, blocked chats | No chat is superseded, blocked or a worker; Auto Off has no ticket to cancel. |
| `ConfigWriter` | Settings (`cos-core`) | Implemented by `Settings::update`. |

A chat-scoped Goal or Loop switch and `loopAfterTurn` on `POST /settings` go to the Goal owner
(`cos-goal`, `state/goal-switches.json`) through the `ChatSwitches` port. With `NoChatSwitches`
they answer `404 not_found`, as an unclaimed route does, and nothing is written.

## How it is proven

- `tests/models.rs` runs the cases of `test/chat-models.test.ts` that do not open a browser.
- `tests/owners.rs` runs the usage-limit cases of `test/session-usage.test.ts`, and the
  preference and diagnostics cases of `test/bridge.test.ts`.
- `tests/projects.rs` runs the native Project cases of `test/projects.test.ts` and the
  `/project-create` route case of `test/bridge.test.ts` over an in-memory projects owner.
- `tests/routes.rs` covers `/settings`, `/status` and the `/plugin-refresh` handshake.
- `tests/custody.rs` runs the two-browser custody rules of `bridge.ts`.
- `cos-bridge/tests/companion.rs` drives every route over a real loopback bridge on port 0.
- `differential/run.mjs` sends the recorded E2.4 fixtures of `cos-types`, and each
  `differential/scenario*.json`, to the TypeScript bridge (`startBridge` on port 0, vitest, no
  Electron window) and to the release `cos-headless` on a fresh profile with
  `CLF_BRIDGE_PORTS=0`. It compares the answers, the config keys these routes write and
  `state/chat-models.json`. A `send` op admits a message (`enqueueInput` there, `POST /v1/inputs`
  here), so `scenario-status.json` checks the `/status` work parts with recorded chats, waiting
  messages and two browsers. It needs `node_modules` at the repository root.

```sh
node rust/crates/cos-companion/differential/run.mjs rust/target/release/cos-headless.exe
```

## Not ported yet

- `startChatModelDiscovery`: the UI's explicit discovery that starts the browser and opens
  `chatgpt.com/?cos-model-catalog=<nonce>`. The request itself is here (`request(true)`); opening
  the browser waits for the system-browser launcher.
- The Usage view's token totals and verified sends (`usageOverview`, `state/usage-cache.json`).
  Only the account limits the page reports are kept here.
- The log lines of `goalHelperSelection` when the helper model falls back.
- `browserWindowBounds` from the display work area: no display is known to the Core yet, so
  `/status` sends the size without a position, as TypeScript does with no work area.
