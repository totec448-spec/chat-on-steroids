# Browser bridge port selection — issue #235

Contribution based on upstream `04c6a29`, developed in a separate worktree on
`codex/235-browser-bridge-port`. The original checkout and other worktrees were preserved.

## Change

- Settings → Browser & history exposes Auto and 8765–8769. Fresh/legacy configurations
  default to Auto; invalid explicit values fail validation. The environment override retains
  precedence, including port 0 for tests, and disables the selector.
- The existing config queue validates the latest merged proposal, then the bridge lifecycle
  queue reserves a gated listener before persistence. A failed bind or config write releases
  the reservation without changing the working bridge or saved choice. Auto treats the current
  listener as available at its existing position in candidate order.
- Successful publication preserves pairing, pending commands and receipts, replaces the wake
  transport, resets browser-control/presence, and drains the old listener outside the config
  queue. Shutdown cancels preparation and prevents listener resurrection during publication.
- Startup bind failure keeps the saved choice and shows the error in Setup. Failed Settings
  saves restore the focused selector; inherited queued snapshots cannot retry a rejected edit.
  Spanish, Japanese, Simplified Chinese and Traditional Chinese catalogs are updated.
- App/extension versions, bridge protocol, extension discovery and permissions are unchanged.

## Automated evidence

`npm ci` completed with no audit vulnerabilities. Node 22.22.0 produced an engine warning
because jsdom 30.0.1 requests Node 22.22.2 or a supported newer version; dependencies were not changed.

Before implementation, config/bridge/IPC/renderer-state baseline: **4 files, 706 tests passed**.
The completed focused pass covered config, candidate resolution, lifecycle, bridge, IPC,
renderer-state, all four localization suites, input delivery and MCP shutdown:
**12 files, 1021 tests passed**. This includes real ephemeral HTTP binds, a gated reservation,
occupied-target and disk-failure rollback, current-port reuse, overlapping saves, shutdown on
both sides of persistence, wake reconnection and retained command/ACK identity.

`npm run typecheck`, `npm run build`, and `git diff --check` passed. Full `npm run verify`
also passed its privacy, license notices, native-source inventory and typecheck gates.
Final full-suite result: **216 files / 5675 tests passed, 2 tests failed, 44 tests skipped**.
Both failures are the unchanged baseline issues below. The isolated MCP shutdown suite passed
separately (**6 tests**), since the failing full-suite command stops the verify chain.

Two unrelated failures were independently reproduced on an untouched `04c6a29` worktree:

- `renderer-chat-models`: a test expects `400,000`/`400.000`; this Windows locale produces
  `400 000` with a nonbreaking space.
- `computer`: Windows screenshot capture returns `HELPER_ERROR: The parameter is incorrect`.

An initial full run also hit a temporary-file rename `EPERM` in input delivery. That suite
subsequently passed both on the original base and in the 1021-test contribution pass. The final full-suite run also passed input delivery and the corrected command/ACK regression.

## Development runtime evidence

Run `npm run build`, set `COS_TEST_CHROMIUM` to an extension-capable Chromium binary, then run
`node scripts/verify-browser-bridge-port.mjs`. It uses isolated Electron userData, the production
renderer/preload/Settings IPC, real loopback listeners, and a separate Chromium profile.
Generated reports, browser profiles and encrypted fixture credentials remain under ignored
`outputs/browser-bridge-port/`.

Verified with Electron 44.3.0 and Chrome for Testing 153.0.8010.52:

- Fresh/legacy Auto; fixed 8765, 8767, 8768 and 8769 save and bind.
- Port 8766 was already occupied by another process. Rejection preserved the prior listener
  and config; that process was not disturbed. Successful live binding of 8766 remains untested.
- Stopping, loading a saved fixed choice, and starting while a fixture owns that port leaves
  the bridge stopped, retains the choice and shows `EADDRINUSE` in Setup. A free choice recovers.
- A real `CLF_BRIDGE_PORTS=0` override controls binding, disables the dropdown and rejects
  explicit port edits through Settings IPC.
- The real MV3 worker rediscovered a switched port and authenticated the replacement wake
  socket with the unchanged pairing token in approximately **30 seconds**, through its existing
  maintenance cycle. No retry action or signed-in ChatGPT conversation was used.

For isolation, the copied companion's discovery list contains only ports successfully owned
by the fixture. A test-only reference calls its existing status handler from its exact worker
context; pairing, HTTP, maintenance and reconnect implementations are unchanged. Worker selection verifies the companion manifest before using its execution context.

This proves development runtime behavior, not installation, release packaging, or a signed-in
provider workflow. Startup recovery used the real stop/load/start lifecycle in the isolated
Electron process; a packaged application restart was not exercised.
