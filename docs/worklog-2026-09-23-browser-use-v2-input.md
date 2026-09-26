# Browser Use restoration and V2 input foundation

## Scope

- Restored the archived isolated Browser Use vertical subsystem from enhanced commit
  `b8d0ceecfe7b0a871da20301cafc8e0e8fb9ec4a` onto the current repository architecture.
- Added the right-side Browser panel, fixed preload/IPC allowlist, Core `browser` tool and
  migration-safe `browserUse` capability.
- Kept Browser Use independent from Internal Chromium, the ChatGPT bridge, recorder and
  companion extension. Its persistent partition remains `persist:cos-web`.
- Began Browser Use V2 at its existing input owner: coordinate move/click/double-click,
  mouse/touch drag, touch swipe and long press with bounded duration and snapshot validation.

## Input invariants

- Coordinates are CSS pixels inside the viewport returned by the exact observation.
- Refs and coordinates share the same tab/document/origin/layout snapshot authority.
- One action invalidates its snapshot; navigation and panel resize invalidate it immediately.
- A newer gesture cancels the older gesture for that tab.
- Interrupted mouse/touch gestures attempt release/cancel without targeting another document.
- No generic CDP, Electron or main-process API is exposed through MCP or preload.

## Validation run so far

- `npm run typecheck` — passed.
- Browser Use unit/renderer tests — 44 passed.
- Focused MCP, IPC, permissions, config, platform and renderer/layout battery — 436 passed,
  6 skipped.
- Internal-variant cross-boundary battery, including its existing hosted-browser suites —
  454 passed, 6 skipped; the final narrowed IPC suite passed 89/89 in both repositories.
- Internal x64 package completed; the packaged main, preload and renderer payloads contain the
  Browser Use boundary, while source diffs for Internal Chromium, bridge, recorder and extension
  remain empty.
- Impeccable UI detector — one warning in the pre-existing Files Markdown blockquote rule;
  no Browser Use finding and no unrelated cleanup performed.

Installation and live website acceptance remain separate later evidence gates.

## First-open repair

- The renderer retains the panel-opening intent while the animated grid track still reports a
  zero-width browser surface. The first later valid geometry performs the exact `show` request;
  ordinary resize notifications can no longer downgrade that intent into a layout-only update.
- Closing and reopening repeats the same owned transition, so the retained tab and its native
  `WebContentsView` become visible together instead of showing a tab above an empty black surface.
- The renderer consumes the authoritative `show` reply as well as state-change events, so an
  opening error is visible to the user.
- Browser action buttons use the same 30 px control and 15 px Phosphor glyph geometry as the
  neighboring Files toolbar.
- A focused regression reproduces first open, valid geometry, close, zero-width reopen and valid
  geometry again, requiring two `show` requests and the same Google tab after reopening. Both
  repositories passed all 44 Browser Use tests and `npm run typecheck`; live acceptance of the
  rebuilt application remains outstanding.

## Live Core-tool acceptance

- An upgraded installation correctly kept the new `browserUse` capability off until the user
  enabled **Use in-app browser**. Republishing the Core surface then exposed and dispatched the
  `browser` tool; refreshing Plugins was unrelated because Browser Use belongs to Core.
- The live run created an isolated `about:blank` tab before requesting origin consent. No target
  website loaded before approval. After approval, direct Browser Use operations completed and a
  stale observation was rejected without acting on the changed page.
- Core instructions begin with `list` and use top-level `open` when no active tab exists.
  The first request for an unapproved origin now returns `approval_required` immediately before
  network navigation; after the in-panel decision, the agent retries the returned navigation.
  Human consent no longer consumes the same 60-second wall budget as code mode.
- `state` no longer silently selects a named background tab. Explicit `select` owns that change.
  Loading tabs return `loading` before snapshot work, while `wait` listens for Chromium's real
  loading boundary. Changed documents return recoverable `target_lost` instead of a misleading
  tool refusal, and `done` explicitly preserves the panel and tabs.
- DOM targets now include bounded HTTP(S) `href` and nearest row/list-item context where present,
  reducing ambiguous duplicate-link clicks without exposing a broader page or process API.
- Persistent approval remains exact-origin scoped. The live Wikipedia flow legitimately crossed
  `www.wikipedia.org`, `en.wikipedia.org` and `pt.wikipedia.org`; it does not grant a broad
  `*.wikipedia.org` wildcard.
- The audited run lasted 10m30s and made 52 Browser Use calls plus 31 code-mode wrappers. Its
  six rejected calls traced to the old blocking consent collision, missing-tab bootstrap, one
  invalid invented action and changed-document races. The mission/tab flow itself preserved two
  tabs, history, reload and content across `done`; it did not actually close/reopen the panel,
  so that earlier claim is recorded as unproved rather than accepted.
- Mainstream and Internal Chromium both pass typecheck and the same focused Browser Use, IPC,
  renderer, instruction, session and platform-contract battery (352/352 tests in each repository).
- All 26 standalone/common feature files are byte-identical between repositories. The ten mixed
  shell/integration files were reviewed separately and retain only their expected Internal Chromium
  host/dock differences; the Browser Use owners stay independent. No Internal Chromium owner or test
  has a source diff from its repository baseline.
- `git diff --check`, privacy, notice/native-source and Electron-resolution gates passed. The broad
  Vitest gate exposed stale test harness contracts for the new `ipcMain.on` listener and Core
  `browser` declaration; those contracts were repaired in both repositories. Its unrelated
  PowerShell/ripgrep timeout passed alone. A final whole-suite rerun was stopped after excessive
  runtime, so this worklog deliberately does not claim a completed all-suite `verify`.

## Post-mission observation and snapshot hardening

- `list` and `state` are passive. They refresh the idle deadline only when a mission is already
  active and cannot recreate mission visuals after `done`; explicit control actions still start
  the mission.
- Every document-bound CDP read now races the exact tab document lifetime and an eight-second
  local bound. Top-level or same-document navigation aborts the old lifetime immediately, so a
  late Chromium reply is consumed but cannot outlive code mode or publish a stale snapshot.
  A stable but unresponsive document returns recoverable `BROWSER_STATE_TIMEOUT` with
  `status: timeout` and `next: state`.
- The model-visible Browser Use contract now names the current `snapshot_id` requirement for all
  input actions, including scroll, and the `loading → wait → state` path. This clarifies the
  existing safety fence instead of weakening it or inferring a new snapshot.
- Element snapshots project bounded `expanded`, `pressed`, `selected` and native/ARIA
  `checked` state, including the `mixed` value, without exposing arbitrary page evaluation.
- Mainstream and Internal Chromium have identical SHA-256 hashes for the three changed Browser
  Use owners and their two focused test files. Neither Internal Chromium nor bridge/continuation
  owners were edited by this repair.
- Both repositories passed typecheck and the focused Browser Use suites (44/44 each). Mainstream's
  adjacent code-mode/MCP battery passed 207 tests before exposing one vocabulary-boundary failure;
  the single repaired Core/Desktop surface case then passed alone in both repositories. Live
  reproduction of the former 75.8-second navigation race remains an installed-runtime check.
- Mainstream's complete `npm run verify` subsequently passed privacy/notices, typecheck, Electron
  resolution, 5,998 broad tests and 26 isolated native/shutdown tests. Production builds then
  completed in both repositories; their pre-existing dynamic/static import warnings were unchanged.

## Adversarial semantic-state acceptance

- The installed-runtime run recorded 45 tool calls: 31 Browser Use operations and 14 code-mode
  wrappers. Compact states immediately before input were deliberate target revalidation, not a
  retry loop. The controlled state/reload race settled in 85 ms with the expected
  `target_lost` result, and no observation remained pending.
- Exact-origin consent was already present, so the W3C origin opened without a new approval. The
  run proved `expanded` transitions before and after reload, preserved the tab across one `done`,
  and kept `mission_active=false` through passive post-mission `list` and `state` calls.
- Live evidence exposed one semantic projection bug: every `HTMLInputElement` owns a JavaScript
  `checked` property, so textboxes were incorrectly reported as `checked=false`. Native checked
  state is now emitted only for checkbox/radio inputs; custom controls still use `aria-checked`,
  including `mixed`.
- The run's only rejected call omitted `ms` from `wait`. Omission now uses a bounded 1,000 ms
  default while an explicit 50–5,000 ms value still wins. The code-mode description also directs
  callers to prefer compact observations for target work and emit `structuredContent.value`
  rather than serializing the duplicated nested result.
- The focused Browser Use owner/tool suites pass 44/44 and Mainstream typecheck passes. The same
  source and regression changes are mirrored to Internal Chromium without importing or editing its
  internal-browser owner.
