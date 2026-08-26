# Computer-use overhaul implementation status

Date: 2026-08-24

This records the first production tranche implemented from
`computer-use-overhaul-plan.md`. The model-facing Desktop connector remains exactly two tools:
`observe` and `computer`.

## Implemented

- RAM-only stage timing for helper/exclusive queue wait, helper execution, UIA traversal,
  screenshot file read/base64 conversion, and recorder wait.
- Helper prewarming when screen/control capabilities are actually published; clipboard-only
  configurations do not start the Windows helper.
- Evidence-based focus confirmation with immediate success for an already-active window; the
  fixed 120 ms focus wait, fixed 30 ms UI action wait, generic 20 ms action wait, dummy wait-0
  cursor action, and fixed 150 ms first-UI retry are removed.
- Per-operation helper deadlines under the retained 30 second final watchdog.
- One internal `snapshot` request for window lookup, optional pixels, and optional UIA state.
- Direct top-level window lookup rather than a full window enumeration for active/specific
  window state.
- Bounded UIA traversal using ControlView TreeWalker plus CacheRequest, with traversal work as
  well as returned output capped.
- Bounded helper-side UI snapshots containing live AutomationElement handles. Model refs carry
  helper generation and snapshot id; actions resolve the cached handle in O(1), validate the
  original root/element identity, and fail stale without a RuntimeId rescan.
- Background-first `PrintWindow` capture with a labeled visible-screen fallback. Observation
  never focuses its target; physical fallback input focuses only on the mutating path.
- Sixteen immutable recent screenshot frames. Unrelated observations no longer invalidate a
  frame; window-bound coordinates retain target HWND and geometry (including crops), and the
  helper revalidates/focuses that exact target immediately before SendInput.
- Exact partial-batch evidence (`completed_count`, `failed_index`) and compact route evidence
  (`uia`, `sendinput`, `focus`, `local`).
- Compact same-call postconditions for foreground window, window open/close, and UI
  appear/disappear, with bounded local polling and optional result capture.

## Deliberately deferred

- Windows.Graphics.Capture/Direct3D capture and a persistent GPU capture stream.
- Binary/named-pipe image transport that removes the temporary PNG file.
- Request-id helper multiplexing, per-window background concurrency, and lock splitting. The
  helper still has one in-flight request, and physical SendInput remains globally serialized.
- Caller/session namespaces for frame records. The bounded frame store is immutable and
  geometry-validated but remains app-global until exact caller identity is available without
  adding an attribution wait to ordinary Desktop calls.
- Screenshot/UI deltas and `sinceSnapshot` model-facing observation input.
- Recorder reservation/asset persistence decoupling. Durable ordering and shutdown flush remain
  more important than claiming an unproven latency win.
- A dedicated native .NET helper rewrite. The PowerShell/C# helper remains the measured,
  low-dependency implementation until the remaining overhead justifies a packaging change.

## Verification

- Focused computer/MCP/connection gate: 12 files, 186 tests passed.
- Full `npm run verify`: privacy gate passed; 52 files, 1,424 passed, 1 skipped.
- `npm run build`: production main, preload, and renderer bundles built successfully.

These gates prove source behavior, Windows helper integration on the test machine, and bundling.
They do not prove every third-party UIA provider, occluded modern DirectComposition window, DPI
layout, lock-screen transition, or multi-agent live workflow; those remain live benchmark/repro
work rather than claims made from unit tests.
