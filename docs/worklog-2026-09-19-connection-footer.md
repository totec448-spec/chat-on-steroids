# Connection control in the sidebar footer — 2026-09-19

## Scope and source

The red top-right Connect button and the footer status square came from upstream
`c91f1be5` (totec448-spec, 2026-09-17). Upstream kept the button visible until a confirmed
connection, while the square opened diagnostics. This change keeps those distinct actions but
groups them visually in the sidebar footer. It is mirrored in mainstream and Internal Chromium;
the Internal browser and View-menu differences are untouched.

## Behavior

- Disconnected, offline and failure states expose Connect beside the status square. During
  connection/disconnection the action is disabled and shows progress text. A confirmed connection
  contracts it into the status square; disconnect expands it again.
- Connect retains the existing Setup route when required configuration is missing and the existing
  reconnect path when the endpoint is already running. The status square still opens the diagnostics
  popover in every state. Keyboard focus transfers to the square when a focused Connect contracts.
- Header terminal/files/agents controls now attach to a stable `headerActions` container rather
  than the removed `headerConnect`. The footer wraps safely in a narrow sidebar. Reduced-motion
  preference removes the transition.

## Evidence

- Both repos: typecheck, focused renderer layout/state tests and Electron/Vite build passed.
  Mainstream: 94/94 tests; Internal: 95/95.
- `scripts/verify-pr-workspace.cjs` passed in both repos with an isolated synthetic backend and
  real Chromium renderer. Screenshots and geometry checked disconnected, connected and narrow
  footer states in `outputs/pr-workspace/`.
- Impeccable UI detection was run on touched renderer files. Its initial new layout-transition
  warning was addressed by switching the morph to a grid-column transition; remaining reported
  findings concern existing, unrelated UI areas.
- Mainstream `npm run verify` reached 5,458 passing tests and one timeout in the unrelated
  Windows `exec-hints.test.ts` cut-pipeline case. That exact test passed immediately when rerun
  alone (1/1). The full Internal suite was not run; its focused checks and build passed.
- This is source/build/synthetic-renderer evidence, not a live tunnel or signed-in ChatGPT test.

The pre-existing dirty Pet work remains separate and was not committed or published here.

## Follow-up: missing companion banner

The missing-extension warning used `isRunning(status.state)`, so a Connect attempt could show it
for `starting-server` and immediately hide it when the tunnel failed. The profile used for the
visual report currently records `tunnel-client was not found`; this failure is separate from
companion presence. The warning now follows `bridge.present` after Setup is complete, and stays
visible across endpoint transitions until the companion actually reports in. Incomplete Setup
still suppresses that competing warning.

The updated renderer-state regression covers starting, connecting, tunnel failure, disconnected,
connected, offline, companion arrival and incomplete Setup. Both repos passed the focused suites
(94/94 mainstream, 95/95 Internal), typecheck and build. The isolated real-Chromium workspace
fixture passed in both repos and captured the visible warning after a synthetic tunnel failure.
Impeccable's detector reported no findings for the changed UI source.

A later full mainstream verification run was stopped after an unrelated ownership test in
`mcp.test.ts` failed under the concurrent suite. That exact test passed immediately in isolation
(1/1); this follow-up does not claim a completely green full-suite run.

## Follow-up: stable connection-phase geometry

The initial footer styling used an 84 px Connect track and a second 124 px track selected by the
status square's busy class. Changing the label and then animating that second width produced a
visible Connect → cramped Connecting → expanded Connecting sequence. The action now uses one
112 px expanded track for Connect, Connecting and Disconnecting; only its actual contraction to
the connected status square changes geometry.

The renderer layout test rejects a busy-only width rule. The Chromium fixture measures identical
idle/connecting widths, verifies the localized connecting label does not overflow, captures the
normal/connecting/narrow states and passed in both repos.

## Follow-up: one action per connection state

The status popover no longer duplicates Connect. The footer owns Connect and its pending labels;
the popover exposes only Disconnect after a confirmed connection. Pressing Disconnect closes the
popover before the asynchronous transition starts, so `Disconnecting…` is communicated once in
the footer instead of appearing beside a second action inside diagnostics.

The neighboring Settings action is now an accessible icon-only 36 px hit target. Live review
removed its competing card border: a 22 px gear sits directly on the footer and responds with
color on hover. The selected Settings state retains the navigation highlight. The connection
group uses the released width and stays pinned to the right,
so its status dot remains the footer's rightmost control.
The sidebar now stops resizing at 220 px, leaving the expanded connection group inside its padded
content box instead of allowing it to spill into the workspace.

The compact diagnostics surface and Advanced content now reuse the composer's 140 ms `surface-in`
reveal. Advanced has an 8 px separation from the status rows. Connect uses the semantic green wash;
the popover's Disconnect action uses the matching red wash and retains its explicit label.

After this follow-up, both repos passed typecheck, production build, the real-Chromium compact
popover/disconnect/workspace fixtures, and the focused renderer suites (94/94 mainstream and
95/95 Internal). Impeccable reported only pre-existing findings outside this footer change.

## Follow-up: stable Disconnect slot

Hiding Disconnect while offline left the compact popover with a changing footer and the expanded
three-column action row with an empty final cell. Disconnect now remains in that final slot in
every connection state. It is neutral and disabled while unavailable, then receives the existing
red danger treatment only after a confirmed connection. The action and asynchronous disconnect
authority are unchanged.
