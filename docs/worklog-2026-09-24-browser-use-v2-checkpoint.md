# Browser Use V2 checkpoint — 2026-09-24

## Completed slices

- Browser Use owns an isolated in-app browser session, tabs, consent, semantic snapshots,
  navigation, interaction and mission lifecycle. It remains independent from Desktop Companion
  browser control and Internal Chromium.
- Design inspection adds an explicit Inspect toggle, semantic selection details, a persistent
  selected-element outline, bounded style/source candidates and an explicit Ask agent handoff.
- Inspection teardown is authoritative: turning it off disables Chromium inspection rather than
  merely hiding renderer UI. Navigation, tab changes, panel hide and Escape invalidate the exact
  selection/document owner.
- Core `browser` and Desktop `browser_*` now have unambiguous model-facing identities. Browser
  Use routes to Core; existing companion-exposed/ChatGPT tabs route to Desktop. Missing Companion
  is never reported as evidence that Browser Use is unavailable.
- No automatic cross-surface fallback, proxy or shared runtime authority was introduced.

## Evidence at checkpoint

- Browser Use and renderer focused tests passed in both repositories during the Design Mode work.
- Browser routing tests: 43 focused tests plus four MCP identity/schema-budget cases passed in
  each repository.
- Typecheck and `git diff --check` passed in both repositories.
- The ten common routing production/test files were SHA-256-identical across the mainstream and
  Internal repositories at the checkpoint.
- Live Browser Use E2E covered semantic accordion/checkbox states, reload, two tabs, one `done`,
  passive post-`done` inspection and preserved content. Design inspection was accepted visually.

## Deliberate limits

- Existing provider conversations may retain an old connector tool catalog. They need a Core
  connector refresh or a new conversation to discover a tool that was absent from that catalog.
- No commit or push was made at this checkpoint. The source trees intentionally remain dirty with
  the reviewed Browser Use V2 work.

Detailed implementation notes remain in:

- `docs/worklog-2026-09-24-browser-use-design-inspection.md`
- `docs/worklog-2026-09-24-browser-surface-routing.md`
