# Composer slash modes and interactive mode panels

## Behavior

The composer now recognizes leading `/goal`, `/plan`, `/loop` and `/compact` commands and exposes them through the same slash autocomplete surface as other composer commands. Selecting one consumes the command instead of sending it as prose and moves that mode into the composer-owned panel above the input.

Goal and Loop use the existing automation owners and remain mutually exclusive. Their lifecycle UI stays interactive, including explicit Goal termination without stopping the current ChatGPT turn. Plan becomes an armed composer mode, generates through the existing task planner, keeps its own progress/result panel independent from later draft edits, and sends the generated stages through the existing input/checkpoint path. Compact invokes the existing continuation control for an eligible selected session and exposes its running/cancel state in the panel.

The plan/Goal/Loop/Compact surfaces share the composer dock layout, dismissal animation and queue presentation. Generated plan stages remain editable before send, and queue order is visible after admission. `session_finish` now holds while the persisted `update_plan` still contains unfinished steps so the displayed plan cannot silently remain pending after the agent declares completion.

Compact & Resume also handles a provider-final response whose native Stop control remains mounted: once the exact handoff is durably accepted, the source page can clear only that residual generation after revalidating the same chat, marker and terminal answer. The synthetic cleanup is excluded from user-stop accounting.

The app's extension-update notice now distinguishes package version from bridge compatibility. An older companion version that is actively speaking the current bridge protocol does not trigger an extension-update warning merely because a local app build carries a newer package version. A proven protocol-incompatible older companion still produces the existing recovery action. This change is app-side only; it does not modify the companion extension for that warning behavior.

## Verification

Focused renderer, bridge, content-script and finish tests cover slash autocomplete and execution, mode panel behavior, Goal termination, Plan generation/cancellation/admission, Compact controls, residual compaction cleanup, persisted-plan finish holding, and compatible-versus-incompatible extension version handling.

Before commit, `git diff --check` passed. Seven focused suites passed **1,244 tests**, followed by a clean TypeScript typecheck.

The complete `npm run verify` gate then passed with **4,433 main-suite tests** across 176 files plus **2 isolated MCP shutdown tests**, with 129 declared skips. Public-history privacy, 92 production-package notices, seven plugin catalog entries, 730 pinned native-source archives/patches and TypeScript all passed. The first complete-gate attempt exposed an ignored development artifact at `resources/tunnel/tunnel-client` that made the tunnel locator test see a fallback binary; running that test with the generated artifact temporarily out of the source tree passed all 31 cases. The artifact was restored, and the complete gate was rerun under the same clean test condition and passed.
