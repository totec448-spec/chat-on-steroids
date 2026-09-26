# Browser Use design inspection — 2026-09-24

## Scope

Implemented the first isolated Design Mode slice inside Browser Use only:

- toolbar Inspect toggle using the shared Phosphor icon system;
- native CDP hover highlight and click-to-select behavior;
- a restrained persistent inline outline on the selected element so its spatial target remains clear;
- bounded tag, accessible role/name, selector and dimensions summary;
- bounded classes, margin/border/padding/content box model and twelve allowlisted computed styles;
- up to five read-only, probabilistic source candidates from exposed React/Vue development
  metadata and matched author CSS locations;
- an explicit Ask agent action that captures a viewport-clamped PNG crop only on request and
  prepares editable composer context without sending it;
- cancellation on Escape, panel hide, navigation/reload, tab switch/close and toggle-off;
- exact active-tab plus navigation-epoch ownership for selection events.

No automatic selection screenshot, full-page screenshot attachment, exhaustive computed-style
dump, external source-map fetching/decoding or source CSS editing was added. Browser Use remains independent from the companion
extension, bridge, recorder and Internal Chromium subsystem.

## Ownership and protocol

`src/main/browser-use.ts` is authoritative for inspection state. The renderer can request only
`inspect { tabId, enabled }` through the fixed Browser Use IPC schema and projects the returned
state. Chromium's `Overlay.setInspectMode` consumes selection input. A selected backend node is
resolved only while the original tab/document epoch remains current; late CDP results are ignored.
Remote values are bounded again in main, and unknown computed-style properties are discarded.
Framework metadata and matched CSS locations are separately bounded, deduplicated and labeled as
source candidates; they are never treated as proof that a file is the correct edit target.
Selection publishes no screenshot. Ask agent names the exact selection id; only then is the
visible rect padded, clamped to its viewport, capped at 640 × 360 DIP and resized to at most
560 × 320 output pixels. Captures above 512 KiB are refused, and any selection or document change
discards the request. The resulting screenshot and bounded runtime details are added visibly to
the current composer draft; they are never sent automatically. Main preserves the selected
element's prior inline `outline` and `outline-offset`, applies the visible contour to that exact
backend node, restores the prior values for capture, and reapplies the contour afterward. The
annotation adds no page node, timer, resize watcher or second selection owner.
Toggle-off awaits Chromium's authoritative `Overlay.disable` teardown before retiring main-owned
inspection state. A teardown error therefore leaves the control visibly active instead of hiding
the UI while Chromium still intercepts input. While inspection is active, its exit button remains
available even across a transient page-loading state.

## Validation

- `npm run typecheck`
- `npm test -- --run test/browser-use.test.ts test/renderer-browser-panel.test.ts`
- Same focused checks in the mainstream and Internal repositories.

The tests cover CDP mode activation, authoritative domain teardown, truthful teardown failure,
selected-node projection, navigation invalidation, tab-switch invalidation, the renderer summary,
bounded framework/CSS source candidates,
zero selection-time image capture, persistent selected-node outlining, prior-style restoration,
clean context capture, editable Ask agent staging,
an active exit control during transient loading, and Escape cancelling inspection without closing
the panel.
