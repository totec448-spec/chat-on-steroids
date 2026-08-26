# Computer Use Overhaul Plan

Date: 2026-08-24

## Decision in one paragraph

Keep the model-facing Desktop surface at **two tools: `observe` and `computer`**. The current surface is already compact and capable. The overhaul should happen behind those tools: remove fixed sleeps, make window capture background-first, cache UI Automation snapshots and element handles, keep per-window/per-agent state instead of one global "latest frame", verify batches inside the same call, return deltas instead of repeatedly shipping full state, and narrow locks to the resource actually being touched. The target is a hybrid driver that uses semantic Windows APIs first and physical SendInput only as an explicit last resort. Do not copy large MCP surfaces with dozens of tiny tools.

## What is already good and should stay

- Separate Core and Desktop MCP surfaces.
- Only two Desktop tool names.
- The public contract cleanly separates observation (`observe`) from mutation (`computer`), even though the current window-capture implementation has a focus-steal bug called out below.
- `computer.actions[]` already batches up to 20 actions in one MCP call.
- `captureAfter` already combines action and visual verification under one lock.
- Screenshot `frameId` already catches one important stale-coordinate case: another capture by this app. The audit found that it still needs stronger external desktop/window invalidation, described below.
- UIA refs beat coordinates when Windows exposes a real control.
- The PowerShell/C# helper is persistent, so Add-Type and process startup are not paid on every call.
- Clipboard steps can be mixed into a single ordered action batch.
- Deterministic validation happens before side effects where possible.

The optimization job is therefore mostly about **latency inside a call and avoiding unnecessary calls**, not expanding the public vocabulary.

## Measured baseline on the current tree

Local read-only benchmark on 2026-08-24, warm helper:

| Operation | Average |
| --- | ---: |
| `listWindows()` | 8.5 ms |
| `activeWindow()` | 9.6 ms |
| screenshot 320 px, primary monitor | 65.3 ms |
| screenshot 1280 px, primary monitor | 95.5 ms |
| `findUi(maxResults=10)` | 38.8 ms |
| window state, UI only | 53.1 ms |
| window state, screenshot 320 + UI | 250.0 ms |
| window state, screenshot 1280 + UI | 275.4 ms |

Cold helper startup was measured at roughly **850 ms once** on this machine. `checkAvailable()` currently has no normal runtime caller, so the first real Desktop request can pay that bootstrap cost unless something else happened to warm the helper first.

Focused follow-up:

| Operation | Average |
| --- | ---: |
| focus an already-active window | 131.0 ms |
| primary screenshot 320 px | 64.8 ms |
| active-window screenshot 320 px | 189.2 ms |
| active-window screenshot 1280 px | 218.3 ms |

The main conclusion is clear: current primitive capture/UIA work is already fairly quick, but fixed settle delays and extra composition work dominate common `observe` flows.

## Current hot path

```text
ChatGPT
  -> MCP Desktop / observe
  -> getWindowState
     -> activeWindow OR listWindows        helper RPC
     -> screenshot(window)
        -> Try-Focus
        -> fixed 120 ms sleep
        -> CopyFromScreen + scale + PNG    helper RPC
        -> write temp PNG
        -> Node reads temp PNG
        -> Node base64 encodes PNG
        -> temp directory deleted
     -> findUi
        -> FindAll(descendants)
        -> Current property reads          helper RPC
  -> build text + image MCP result
  -> recorder queue
     -> base64 decode screenshot again
     -> write screenshot asset
     -> append event
  -> MCP response reaches ChatGPT
```

For a semantic action today:

```text
ChatGPT
  -> computer(actions[])
  -> resolve every ref
  -> helper act
     -> Resolve-UiElement scans all descendants by runtime id
     -> action
     -> fixed action-specific delay in some paths
     -> unconditional extra 20 ms after every action
  -> optional captureAfter
  -> recorder queue
  -> response
```

## Highest-ROI problems

### P0. Fixed sleeps are currently a first-class latency source

Current fixed waits include:

- 120 ms in `Try-Focus`, even when the target is already foreground.
- 120 ms in the explicit focus action.
- 30 ms after a UIA element action.
- 20 ms after every action in the helper `act` loop.
- 35 ms already inside key chords, followed by the generic 20 ms again.
- 12 ms per drag path point.
- 150 ms cold UIA retry on the first empty query.
- 100 ms polling cadence for `waitForWindow`.

The generic 20 ms sleep also applies to the dummy `{ type: 'wait', ms: 0 }` Node appends to a normal desktop batch, so a regular batch gets an avoidable floor even if every real action finished instantly.

### P0. First-use latency is needlessly exposed to the model

The persistent helper is the right design, but its ~850 ms cold bootstrap should not normally land inside the first model-facing Desktop action. Prewarm it when the Desktop connector is actually enabled/published or when its connection diagnostics run, not unconditionally at application startup.

Requirements:

- do not start the helper for users who never expose Desktop capabilities,
- warm it off the first user action's critical path,
- report/precompute availability without stealing focus or taking a screenshot,
- keep shutdown ownership exactly as it is today.

### P0. Read-only window capture steals focus and then sleeps

`screenshot({ window })` calls `Try-Focus` before `CopyFromScreen`. This causes two problems:

1. Perceived latency: the measured active-window capture pays about 120 ms more than a monitor capture.
2. Semantics: `observe` is documented as not moving focus, but a window screenshot asks Windows to bring the target forward.

The correct long-term fix is not merely reducing 120 to a smaller magic number. Window capture should use a window-targeted capture backend that does not depend on foreground state.

### P0. Semantic refs are cheap to create but expensive to use

`Resolve-UiElement` currently reconstructs an `AutomationElement` by calling `FindAll(TreeScope.Descendants, TrueCondition)` and comparing runtime IDs. A single large Electron/Chromium/WPF tree can therefore be walked again for every `click_ref` or `set_value` action.

This defeats the point of semantic refs. The observation that minted the ref should also cache the actual helper-side element handle/snapshot identity so action-time resolution is normally O(1), with a targeted fallback only when the cached element has gone stale.

### P0. Recording is on the critical response path

When request identity is known, `kernel.ts` awaits `recordToolCall()` before returning the MCP result. `recordToolCall()` is globally serialized through one `recordChain`. For screenshot results it base64-decodes the image and writes it to the session asset store before the model receives the tool result.

That preserves durable ordering, but it means a Desktop call can be delayed by disk work or by an earlier unrelated tool record. Perceived tool speed is therefore not only `computer/*` speed.

The redesign needs to preserve ordering and quit-flush correctness while separating **wire response latency** from **durable asset persistence** where that can be proven safe.

### P1. One global frame and one global exclusive queue are safe but pessimistic

Today any new screenshot replaces `lastFrame`. If agent A observes a window and agent B merely takes another screenshot, A's subsequent coordinate action becomes stale. This is safe, but it creates avoidable retries in multi-agent use.

The physical Windows input queue really is global and must stay serialized. A background UIA action against Window A, however, does not inherently need to block a background UIA read against Window B.

The target should separate:

- global physical-input lease for SendInput / foreground manipulation,
- per-window locks for background UIA/window operations,
- immutable bounded snapshot/frame records keyed by session/caller and id.

There is one important dependency: the current helper protocol itself is also globally serialized. `HelperRuntime` has only one `pending` request and `runHelper()` queues every request behind one promise. Splitting TypeScript locks without changing that protocol would improve ownership semantics but would not create real background concurrency. The sequence should therefore be:

1. coalesce the common observation path into fewer helper requests,
2. introduce request IDs and a pending-request map when the helper can genuinely execute independent work concurrently,
3. only then expect per-window lock splitting to improve throughput under multiple agents.

### P1. The common observation is three native round trips when it should be one

`getWindowState()` currently resolves the target window, captures pixels, and queries UIA as separate helper operations. That is simple, but it repeats routing and serialization overhead and gives the helper no chance to optimize the acquisition as one snapshot.

Add one internal `snapshot` operation that can return, in one reply:

- exact target HWND/window metadata,
- optional screenshot metadata + bytes,
- optional cached UIA projection,
- snapshot identity and capture timestamps.

This is intentionally an internal protocol optimization, not a new MCP tool. It should be implemented before a helper rewrite because it reduces round trips immediately and creates the right protocol shape for a later native daemon.

### P1. One 30 second helper timeout hides which primitive actually wedged

Every helper operation currently shares `HELPER_TIMEOUT_MS = 30_000`. That protects the app from a permanently stuck helper, but it makes a single bad UIA provider or capture backend consume the whole outer timeout before failing. Browser-use has documented the same failure shape with individual CDP operations hanging until an outer 30 second handler timeout.

Keep the outer watchdog, but add per-operation deadlines and cancellation/health evidence. Example classes, tuned from measurements rather than hardcoded blindly:

- foreground/window metadata: short deadline,
- ordinary UIA snapshot: medium deadline with bounded traversal,
- capture: medium deadline with backend fallback,
- explicit user `wait`: caller-controlled deadline,
- outer helper watchdog: last-resort process retirement only.

Fast failure plus a useful fallback is better than spending 30 seconds discovering that one provider call stopped responding.

### P0 correctness issues found during the audit

These are not only performance opportunities.

1. **`frameId` currently proves only "this app has not captured another frame".** It does not prove the real desktop is unchanged. External window movement, animation, overlays, user input or a lock-screen transition can change the pixels while the same `lastFrame.id` still passes validation. Bind a coordinate frame to target HWND + geometry/desktop generation and revalidate that mapping at action time.
2. **UI refs live too long.** They are scoped to helper generation, but Microsoft documents that UIA RuntimeIds can be reused over time. A ref should be snapshot-scoped and backed by a cached AutomationElement/fingerprint; use element identity validation and reject stale refs rather than trusting a reused runtime id.
3. **Partial batch failure is ambiguous.** The helper executes actions sequentially and returns only one final error. Earlier actions may already have happened, so a blind retry can duplicate side effects. Return `completed_count`, `failed_index`, route/error detail and optional compact failure-state capture.
4. **`max_elements` bounds output, not traversal work.** `FindAll(Descendants, TrueCondition)` materializes the full tree before truncation. Use native conditions/TreeWalker/CacheRequest with early stop so huge Electron trees cannot consume the entire helper timeout just to return 20 rows.
5. **`captureAfter` refreshes pixels but not semantic state.** A workflow that needs the next UI ref/value still pays a second `observe`. Add optional post-state/verification to the same `computer` call.

## Target architecture

```text
MCP Desktop
  observe(args)                      computer(actions, verify?)
       |                                      |
       +------------------+-------------------+
                          v
                 Desktop Orchestrator
                          |
          +---------------+----------------+
          |               |                |
          v               v                v
   Snapshot Store     Route Planner     Wait/Verify Engine
   per session/window semantic first    WinEvent/UIA events
   pixels + UIA       fallback ladder   bounded polling fallback
          |               |                |
          +---------------+----------------+
                          v
                 Desktop Helper Daemon
                request-id based protocol
                          |
       +------------------+-------------------+
       |                  |                   |
       v                  v                   v
   Window capture       UIA/MSAA          Physical input
 PrintWindow/WGC      cached elements       SendInput
 no focus needed      CacheRequest          last resort
```

### Public surface remains small

#### `observe`

Keep one tool. Add only compact optional fields where they materially reduce round trips:

- `detail: "auto" | "pixels" | "ui" | "both"`
- `sinceSnapshot` for a delta when the caller already has state
- `query`/`match` remains the projection mechanism
- return `snapshotId` explicitly alongside screenshot `frameId`
- structured content for elements if the ChatGPT MCP client consumes it reliably

`detail:auto` should choose the cheapest truthful representation. A UI-only re-index should not capture pixels. A canvas should not waste time on a giant useless accessibility tree.

#### `computer`

Keep one tool and the existing `actions[]`. Add one compact verification contract rather than a workflow DSL:

```text
computer({
  actions: [...],
  verify: {
    until: <small predicate>,
    timeout_ms: ...,
    capture: "on_change" | "always" | "never"
  }
})
```

Useful first predicates:

- UI query/ref appears or disappears
- UI value equals expected value
- foreground window matches
- target window exists or closes
- pixel region changed by threshold

This lets one call perform `act -> settle -> verify -> compact observation` instead of forcing the model through `computer -> wait -> observe` loops.

Do not add a general scripting language in v1.

## Execution route ladder

Every action should choose the highest-level route that can honestly perform it:

1. **Cached UIA pattern**: Invoke, Toggle, Value, RangeValue, ExpandCollapse, Selection, Scroll patterns where available.
2. **UIA hit test for pixel targets**: if a pixel lands on a semantic control with a supported pattern, invoke the control instead of moving the physical cursor.
3. **Background window input** where the target stack reliably accepts it.
4. **Foreground + SendInput** only when the target requires real system input.

The result should expose a tiny diagnostic such as `route: "uia" | "background_input" | "sendinput"` and, where possible, `effect: "confirmed" | "unverified"`. Do not silently claim success after a route whose effect cannot be checked.

This is the biggest capability upgrade because it allows ChatGPT to work in more windows without stealing the user's mouse or invalidating other agents' state.

## Concrete implementation roadmap

### PR 1: Instrument first

Files:

- `src/main/computer/index.ts`
- `src/main/computer/helper.ts`
- `src/main/mcp/tools-desktop.ts`
- optionally RAM-only timing fields in the existing logger/call evidence

Add timings for:

- exclusive queue wait
- helper queue wait
- window lookup
- focus/foreground confirmation
- capture
- PNG encode/transport
- UIA walk
- UI ref resolution
- action execution
- settle/verification
- recorder wait

No user data values in timing logs.

Gate: baseline p50/p95 can be reproduced automatically before changing behavior.

### PR 2: Delete avoidable sleeps

Files:

- `src/main/computer/helper.ts`
- `src/main/computer/index.ts`
- `test/computer.test.ts`

Changes:

1. Prewarm the helper when the Desktop connector is actually published/enabled so the first real model action does not pay ~850 ms startup.
2. `Try-Focus` returns immediately when `ForegroundId() == id`.
3. When activation is required, replace fixed 120 ms with bounded confirmation, ideally a foreground WinEvent; small polling fallback if needed.
4. Remove unconditional `Start-Sleep 20` after every action.
5. Retain delay only where the Windows protocol actually requires it, and do not stack generic + action-specific delays.
6. Remove the dummy `wait 0` action as a cursor-sampling hack. Return cursor explicitly from the helper batch protocol.
7. Make UI cold-start retry evidence-driven rather than one fixed 150 ms nap where possible.

Event-driven waiting still needs a bounded polling fallback because Microsoft documents that not every UIA provider raises every possible event.

Expected gate, measured rather than assumed:

- focus-already-active should be near helper RPC cost, not ~131 ms.
- active-window `observe` should lose roughly the fixed 120 ms tax before any larger rewrite.

### PR 3: Snapshot cache + O(1) semantic refs

Files:

- `src/main/computer/helper.ts`
- `src/main/computer/index.ts`
- `test/computer.test.ts`

Changes:

1. Add one internal `snapshot` helper request so target lookup + optional pixels + optional UIA are acquired through one protocol operation.
2. Add a direct `WindowInfo(hwnd)` path instead of enumerating every visible top-level window just to describe the foreground HWND.
3. UI observation creates a helper-side `snapshotId`.
4. Snapshot stores exact actionable `AutomationElement` references or a safe cached wrapper, scoped to helper generation + window.
5. Model-facing ref/token includes or maps to snapshot identity.
6. `click_ref` / `set_value` resolves cached element directly.
7. Validate it is still live/enabled and belongs to the same window. Do not rely on RuntimeId uniqueness over time; Microsoft explicitly says RuntimeIds can be reused.
8. If cache is invalid, return a precise stale-element error or use one targeted fallback lookup. Never reinterpret the ref as a different control.
9. Bound snapshots with LRU/TTL.
10. Give each internal primitive a measured deadline while retaining the 30 second outer helper watchdog as a final recovery boundary.

Success metric: semantic action latency should not scale linearly with total descendant count on a large UI tree.

### PR 4: UIA CacheRequest and fallback providers

Files:

- helper implementation, likely `helper.ts` initially

Use UI Automation caching to fetch the properties needed by `observe` in a bulk subtree operation instead of reading `.Current` property-by-property across process boundaries.

Microsoft explicitly documents individual UIA property retrieval as slow because it causes cross-process calls, and recommends cache requests/bulk fetching for this exact case.

Cache at least:

- Name
- AutomationId
- ControlType
- BoundingRectangle
- IsEnabled
- IsOffscreen
- supported action patterns needed for routing

Add carefully scoped fallbacks for provider failures. MSAA is useful for specific legacy providers, but should not automatically double every tree walk.

### PR 5: Background window capture

Files:

- helper implementation
- `src/main/computer/index.ts`
- capture tests

Route window pixels through a target-window backend:

1. Try an efficient direct window capture for classic surfaces.
2. Fall back to Windows.Graphics.Capture for DirectComposition/WinUI/UWP/modern surfaces.
3. Screen-region capture only as a clearly marked fallback when truthful window pixels cannot be obtained.

Important behavior changes:

- `observe(window)` no longer steals focus merely to take a screenshot.
- occluded-window screenshots become truthful rather than pictures of the covering window.
- the 120 ms focus settle disappears from normal window observation.

Do not ship a backend until black-frame, minimized-window, occlusion, DPI and multi-monitor cases have explicit tests/repros.

### PR 6: Remove the temp-file screenshot hop

Current:

```text
Bitmap -> PNG temp file -> filesystem -> Node Buffer -> base64 -> MCP
```

Target:

```text
Bitmap/WGC frame -> in-memory encoder -> binary helper response/pipe -> Node Buffer -> MCP
```

Prefer a framed binary side channel or named pipe rather than embedding multi-megabyte base64 inside the helper's NDJSON control stream.

This removes temp directory creation/deletion, antivirus/indexer jitter, disk reads and one unnecessary representation boundary.

### PR 7: Per-window/per-agent snapshots and lock splitting

Files:

- `src/main/computer/index.ts`
- caller/session integration from MCP call context
- tests for multiple workers

Replace `lastFrame` as the only coordinate identity with a bounded immutable frame store. Each frame records:

- frame id
- caller/session namespace
- target window/desktop scope
- region + scale
- target window geometry/version
- capture time

A later screenshot by another agent should not automatically make the frame invalid. A coordinate action is legal only if its referenced target geometry/desktop generation still proves the same coordinate mapping.

Lock strategy:

- global lease: SendInput, foreground changes, full desktop physical cursor operations
- per-window lock: UIA snapshot/action, target-window capture, background delivery
- snapshot store lock: tiny metadata critical sections only

This is the main multi-agent scalability change.

Real parallel throughput requires the helper protocol to support more than one in-flight background request. Do not claim a concurrency win while `HelperRuntime.pending` is still a single slot. Either upgrade the helper protocol to request IDs + a pending map with bounded concurrent execution, or make the eventual native helper own that multiplexing. Physical SendInput remains globally serialized regardless.

### PR 8: Verified multi-action execution

Extend the existing `actions[]`, do not create more tool names.

First version:

- execute a deterministic batch
- validate optional postcondition after meaningful transition boundaries
- stop at first failed validation
- return executed count, failing step and compact current state, including the same information when an action itself throws after earlier steps succeeded

Later, safe predictable workflows can contain multiple guarded stages in one MCP call.

The model still chooses the sequence. The local driver only validates state before continuing, which keeps the executor deterministic and testable.

### PR 9: Observation deltas

For repeated observations of the same window:

- hash stable UI elements by runtime identity + relevant fields
- return changed/added/removed controls plus ancestor context
- tile/hash screenshot regions and return a changed crop when small
- fall back to full screenshot/tree when change is broad or confidence is low

Never make delta state the only durable truth. A full snapshot remains available after any inconsistency.

### PR 10: Decouple recorder persistence from Desktop wire latency

Files:

- `src/main/mcp/kernel.ts`
- `src/main/session/recorder.ts`
- session/recorder tests

Goal: preserve exact ordering, crash/quit flush and request attribution without making a screenshot tool response wait for unrelated serialized asset writes.

Possible direction:

1. Reserve ordered event identity synchronously.
2. Copy/own the immutable result bytes before response if required for correctness.
3. Queue asset persistence behind the reserved record.
4. Return MCP result once the response's durable-enough reservation is committed.
5. `flushRecorder()` still drains all asset/event work on shutdown.

This needs the strongest correctness testing in the overhaul. Do not simply make `recordToolCall()` fire-and-forget, because the current global chain was introduced to prevent real reordering and quit-loss bugs.

## Helper implementation direction

The current persistent PowerShell process with embedded C# is a good low-dependency bootstrap and should survive P0-P1.

For P2, benchmark a dedicated long-lived Windows helper against it. A small C#/.NET helper is a natural candidate because the desired features are Windows UIA, WinEvent, Windows.Graphics.Capture, COM caching and binary named pipes. The MCP server should remain in Electron; the helper is an internal desktop daemon, not another model-visible MCP server.

Reasons to move only after measurements:

- direct binary image transport
- real asynchronous Windows event subscriptions
- simpler UIA object/snapshot cache
- request IDs and multiple in-flight background operations
- less PowerShell object/JSON conversion
- easier WGC lifecycle management

Reasons not to rush it:

- packaging/runtime footprint
- another process/version protocol
- signing/update complexity
- current helper startup cost is already amortized

## Browser targets

When the target is Chromium/Electron web content, accessibility writes and generic injected clicks are not always reliable. OpenAI's current GPT-5.4 CUA sample explicitly demonstrates two modes for the same browser tasks: raw computer actions and a persistent Playwright JavaScript REPL.

Long term, an optional browser-aware route can use CDP/Playwright when Chat On Steroids owns a debuggable browser session. This should remain an internal routing optimization or a separate explicitly enabled browser capability, not silently attach to arbitrary private browser sessions.

The generic Windows driver must still work without it.

## Screenshot strategy: adaptive rather than simply larger or smaller

OpenAI's current Computer Use guide explicitly executes the whole returned `actions[]` batch and captures one updated screen after that batch. It also recommends `detail: "original"` for Computer Use screenshots and notes strong observed performance around 1440x900 and 1600x900 desktop resolutions, with downscaling when token use is too high.

That does **not** mean changing the current default from 1280 to 1600 everywhere. For this MCP surface, latency, image bytes and model accuracy should be optimized together:

1. Keep a cheap default observation for routine Windows work.
2. Use window-targeted capture rather than a full desktop whenever possible.
3. Escalate resolution when the target contains dense small controls or prior coordinate confidence was low.
4. Prefer a high-resolution crop around the ambiguous target over resending an entire larger desktop.
5. After a deterministic multi-action batch, return one updated state rather than one screenshot per action.
6. Measure task success, bytes and model turns at 1280-wide, 1440x900 and 1600x900 before changing the shipping default.

The likely optimum is an **adaptive resolution policy**, not one global width.

Local warm capture measurements support treating this as a tradeoff rather than a free upgrade: roughly 81/94/103/109 ms at 960/1280/1440/1600 widths, with corresponding PNG sizes around 125/185/226/261 KB in the sampled desktop state. The latency delta is modest, but payload growth is real. End-to-end click accuracy and model-turn reduction must decide the default, not screenshot time alone.

## What to copy from current external systems

### OpenAI Codex

Copy the runtime principles, not a fictitious desktop API:

- persistent resources instead of process startup per action
- resource-specific interaction locks
- independent resources can progress concurrently
- combine logically adjacent work into one call
- preserve stable handles for long-running state

Codex's unified exec allows different terminal sessions to be polled concurrently while serializing interactions against one terminal. The Desktop equivalent is per-window background concurrency plus one global physical-input lease.

Recent Codex issue reports are also a useful warning about model-driven polling. Multiple 2026 reports show empty status/wait turns creating large amounts of extra model work when the runtime could instead wait locally for output or completion. The current Codex runtime already contains `Notify`, `watch`, cancellation tokens, output notifications and per-process interaction locks. For Desktop, the transferable rule is: **the runtime should own waiting for a known local condition; the model should not burn turns asking whether it happened yet.**

That directly supports the proposed `verify.until` / event-driven settle path.

### OpenAI Computer Use

The current OpenAI Computer Use guide validates three choices already present or proposed here:

- batched `actions[]` are first-class and should be executed in order before the next observation,
- custom harnesses that mix visual and programmatic interaction are expected,
- one updated UI state after the action batch is the normal loop.

So Chat On Steroids should keep its compact two-tool custom harness and make the local executor smarter rather than trying to imitate the built-in tool schema one action at a time.

### Microsoft UFO2

Copy:

- UIA + native API + vision hybrid routing
- speculative multi-action execution with live UI-state validation
- fallback to fine-grained execution when validation fails

Microsoft reports up to 51% fewer LLM queries for its speculative multi-action mode. Treat that number as their workload result, not a promise for Chat On Steroids. It is still strong evidence that reducing model round trips is where large wall-clock gains live.

### Cua Driver

Copy the Windows-specific engineering ideas:

- background-first action routing
- UIA patterns before physical input
- UIA hit-test before pixel fallback
- UI Automation CacheRequest
- direct window capture with PrintWindow/GDI plus WGC fallback
- explicit `background_unavailable`/unverified effects instead of pretending an action landed
- snapshot-scoped semantic handles
- per-agent/session state

Do **not** copy its large MCP tool surface. Its detailed tool catalog is useful as an implementation reference, but Chat On Steroids should keep the two-tool abstraction and route internally.

### desktop-touch-mcp

Harusame64/desktop-touch-mcp is a useful Windows-native comparator because its newer primary path is `discover -> act` with short-lived semantic leases and post-action perception rather than indefinitely reusable raw coordinates.

Transferable ideas:

- scope semantic targets to an observed lease/snapshot and validate the target window before acting,
- return semantic post-action diffs when UIA can describe the result exactly,
- return only a changed ROI/crop when the target is visual and a full image is unnecessary,
- keep several recent captures/leases alive rather than making one unrelated observation invalidate every older frame,
- use `FindAllBuildCache` / batched child traversal with early `maxElements` exit instead of materializing one unbounded descendant tree,
- fall back from semantic state to visual state when the accessibility surface is sparse.

The project reports ~100 ms full-tree UIA on its native Rust engine and much larger improvements for tiny focus queries, but its own explanation is important: most of the huge focus headline comes from eliminating cold PowerShell/.NET startup. Chat On Steroids already keeps its helper warm, so **copy the UIA traversal/cache strategy first, not the language rewrite**.

It also exposes a much broader 32-tool catalog. Do not copy that surface. Its own V2 primary path being two semantic tools is further evidence that the model-facing abstraction should stay compact even if the internal driver is rich.

## What not to do

- Do not turn every action into its own MCP tool.
- Do not solve latency by lowering safety timeouts blindly.
- Do not replace fixed sleeps with smaller fixed sleeps everywhere.
- Do not allow stale semantic refs to silently resolve to a new control.
- Do not weaken frame/caller ownership merely to reduce stale-frame errors.
- Do not parallelize physical SendInput across agents.
- Do not return a 10,000-element tree because structured output exists.
- Do not make screenshot diffs the only state source.
- Do not attach CDP to arbitrary user browser sessions without an explicit trust model.
- Do not rewrite the helper in Rust/C++/.NET before the P0 benchmark proves the remaining overhead requires it.
- Do not make recorder persistence fire-and-forget without preserving the ordering/flush invariants it currently protects.

## Benchmark suite and acceptance gates

### Microbenchmarks

Measure cold and warm, p50 and p95:

- helper startup
- list windows / active window
- UIA snapshot at 10 / 60 / 500+ controls
- semantic ref resolve and Invoke/Value
- primary screenshot 320 / 1280 / 2560
- target-window screenshot visible / occluded / DirectComposition
- 1 / 5 / 10 action batches
- act + verify screenshot
- focus transition
- UIA event wait
- recorder contribution to MCP response latency
- queue wait under two agents

### End-to-end task set

Use deterministic Windows tasks with final-state verification:

1. Notepad: enter, select, replace and save text.
2. Calculator/native app: multi-control semantic workflow.
3. Electron/Chromium app: mixed semantic + pixel workflow.
4. File picker: choose file/folder and verify returned path.
5. WPF app: forms, toggle, slider, modal.
6. Multi-window workflow: copy information from A to B.
7. Two agents on two windows: background semantic operations without cross-state invalidation.
8. Foreground-required canvas/drag: prove global input lease still serializes correctly.

### Metrics that matter

- task success rate
- total model turns
- total MCP tool calls
- median and p95 tool wall-clock latency
- queue wait latency
- screenshots sent
- screenshot bytes sent
- UI elements/tokens returned
- stale frame/ref retries
- foreground steals
- fallback route counts
- unverified action count
- recorder latency contribution

### Initial targets

Targets are acceptance goals, not predicted results:

- remove the ~120 ms already-foreground focus tax
- common semantic actions no longer scale with full UI-tree size
- cut common `observe -> act -> wait -> observe` sequences to 1-2 MCP calls where verification is deterministic
- reduce routine model/tool round trips by roughly 30-50% on the deterministic benchmark set
- no regression in stale-frame/ref safety or cross-agent isolation
- no silent focus steal for read-only window observation
- p95 matters more than shaving a few milliseconds off p50

Practical first-pass performance gates, to validate rather than treat as guarantees:

- warm bare `observe`: p50 <= 150-175 ms, p95 <= 250 ms,
- simple coordinate action without capture: p50 <= 30 ms,
- five-action simple batch excluding intentional waits: <= 50 ms local execution target,
- semantic ref action on a normal UI tree: p50 <= 75 ms,
- cold first user-visible Desktop action: <= 300 ms if safe helper prewarming is introduced,
- zero wrong-target actions in the adversarial move/resize/focus/modal suite.

The existing frozen error-rate sample is already low (`computer` ~0.5%, `observe` 0% in the referenced audit sample), so success criteria must emphasize **wrong-target prevention, coherence, turns and wall-clock latency**, not merely fewer explicit tool errors.

## Recommended order

If only five changes are implemented, do these in this order:

1. **Measure queue/helper/capture/UIA/recorder time explicitly.**
2. **Kill the fixed focus and generic per-action sleeps.**
3. **Coalesce the common observation into one native snapshot request, then cache UIA elements with CacheRequest.**
4. **Move window capture to background, truthful per-window capture.**
5. **Add verified batching and per-window/session state, with helper multiplexing before claiming parallel throughput.**

Then remove the screenshot temp-file path, split locks, add deltas, and optimize recorder persistence.

### Benchmark-gated P3: persistent GPU capture stream

Only after the earlier phases are measured, benchmark a persistent Desktop Duplication / Windows.Graphics.Capture pipeline. Both APIs can expose frame-arrival/change information without asking `CopyFromScreen` to build a fresh full bitmap for every observation; Desktop Duplication also exposes dirty/move rectangles and cursor metadata.

Potential upside:

- event-driven "new pixels arrived" settling,
- native dirty-region/delta capture,
- reuse of a recent GPU frame for small crops,
- less full-frame encode work on mostly-static desktops.

Cost/risk:

- D3D device lifecycle and device-loss recovery,
- desktop switch / lock-session handling,
- HDR/color-format complexity,
- `DXGI_ERROR_ACCESS_LOST` and capture-session recreation,
- likely native helper work.

This is **P3**, not justification for rewriting the current helper before the fixed waits, UIA scans and model round trips are removed.

## Strongest conclusion

The current design does not need more model-facing tools. It needs a smarter executor behind the two tools it already has. The biggest gains come from **removing artificial waits and model round trips**, then from **background semantic execution and stable per-window snapshots**. That gets the system closer to the good parts of Codex's resource handling and modern Windows CUA drivers without inheriting a huge schema or fragile automation DSL.

## Research sources

- OpenAI GPT-5.4 CUA Sample App: https://github.com/openai/openai-cua-sample-app
- OpenAI Codex unified exec process manager: https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process_manager.rs
- Microsoft UFO2 overview: https://github.com/microsoft/UFO/blob/main/documents/docs/ufo2/overview.md
- Microsoft UFO2 speculative multi-action execution: https://github.com/microsoft/UFO/blob/main/documents/docs/ufo2/core_features/multi_action.md
- Cua Driver, Windows computer-use architecture: https://github.com/trycua/cua/blob/main/blog/inside-windows-computer-use.md
- Cua Driver MCP reference: https://github.com/trycua/cua/blob/main/docs/content/docs/reference/cua-driver/mcp-tools.mdx
- Microsoft UI Automation caching: https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-cachingforclients
- Microsoft UI Automation event subscriptions: https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-eventsforclients
- Microsoft UI Automation RuntimeId identity/reuse guidance: https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-usefortesting
- Playwright actionability and conditional auto-waiting: https://playwright.dev/docs/actionability
- OpenAI current Computer Use guide: https://developers.openai.com/api/docs/guides/tools-computer-use
- OpenAI Codex process runtime (`Notify`, `watch`, per-process locks): https://github.com/openai/codex/blob/main/codex-rs/core/src/unified_exec/process_manager.rs
- OpenAI Codex streaming app-server process events: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- OpenAI Codex polling overhead issue #13733: https://github.com/openai/codex/issues/13733
- OpenAI Codex wait/status telemetry issue #35259: https://github.com/openai/codex/issues/35259
- OpenAI Codex polling failure issue #38495: https://github.com/openai/codex/issues/38495
- OpenAI Codex event-driven wake request #32188: https://github.com/openai/codex/issues/32188
- Browser-use per-operation CDP timeout issue #4579: https://github.com/browser-use/browser-use/issues/4579
- Microsoft UIA Remote Operations research implementation: https://github.com/microsoft/Microsoft-UI-UIAutomation
- Harusame64 desktop-touch-mcp: https://github.com/Harusame64/desktop-touch-mcp
- Microsoft Desktop Duplication API: https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api
- Microsoft Windows.Graphics.Capture: https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture
