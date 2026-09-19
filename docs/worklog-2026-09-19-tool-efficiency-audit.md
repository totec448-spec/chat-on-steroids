# Tool efficiency and request ownership audit

## Scope and evidence

The user requested a review of the latest 20 main chats, especially browser/computer reviews,
unnecessary refusals, model-facing returns and request-scoped Unattributed work. Completion
explicitly excludes installation. Other chats are concurrently editing the shared tree.

The frozen recording sample ends at 2026-09-19 07:40:05.212 UTC. It contains 3,547 deduplicated
tool calls across 20 earlier main desktop sessions, including 139 browser/native-desktop named
calls. Three `browser_snapshot` calls belong to an external browser integration rather than
this app's browser implementation. Nested calls and process completion reads are call counts,
not independent failed tasks. The extractor reports no malformed event lines or missing assets.
Raw conversations, identifiers and results remain in ignored `outputs/tool-audit-20260919/`.
Frozen call snapshot SHA-256: `25e25253e526c99ceae13a3f3f358dd6e5494f19bda2863a98187f4577c4559a`.

Of 152 non-ok results, 86 are process exit reports, including deliberately failing regression
tests, comparisons and repeat reads of the same process. They are not 152 infrastructure defects.
Browser refusals include unavailable/closed tabs, protected executor pages and owner changes.
Successful review sequences also reveal repeated attach attempts, fallback desktop captures,
large sidebar snapshots and avoidable re-reads. Four native captures report `CAPTURE_FAILED`;
a text-only observation in the surrounding review flow remains useful.

## Changes

* DOM reviews use the existing `browser_snapshot` operation without needing an attachment.
  A fixed isolated-world reader can inspect active orchestration pages while keeping their
  debugger, focus, overlays and interactive references intact. Its explicit `inspectionOnly`
  response has no action refs. Owned interactive snapshots retain their existing semantics.
* Both modes support a scoped CSS subtree. Literal filter semantics are explicit. Missing and
  invalid selectors are returned through the scripting boundary with their actual diagnosis.
  A hanging inspection is bounded within the existing RPC and cannot stall the browser pump
  indefinitely. Chrome document IDs remain opaque rather than being constrained to page UUIDs.
* Failed attachment cleanup detaches only a connection actually acquired by that attempt.
  A refused attach previously could detach the same extension's orchestration debugger.
* Browser attachments now use a request principal when exact session attribution is pending.
  The paired bridge resolves later aliases through the existing canonical correlation index.
  Browser-provided session claims cannot establish ownership. Exact durable-session proof
  retains access across frontend replacement and worker reconstruction without replaying input.
* Windows combined observations preserve requested UIA controls when pixel capture alone fails.
  `screenshot_error` describes the failure; no image coordinates survive it. Screenshot-only,
  stale-geometry, wrong-window and total observation failures remain explicit.
* Browser/Desktop descriptions and initialization instructions explain direct reviews, scoped
  reads, image-free native observations and the existing background tab/navigation operations.

The existing protected input, current-window targeting, live permission, result-size and
post-navigation checks remain owned by their original implementations. This audit does not
add implicit tab creation, action retries, a parallel identity ledger or arbitrary JavaScript
execution on protected pages.

## Unattributed verification

Focused suites exercise request plans surviving restart and attaching later, exact workspace
inheritance, terminal continuation, code-mode file edits, worker creation and addressed inbox
delivery. Headerless calls remain distinct: ordinary permitted operations work, but a request
plan or worker family still needs a real request identity. An exact session finish cannot name
an unknown session. Unattributed status is not Read-only mode or a global mutation restriction.

The real paired-bridge test resolves held requests from canonical correlation and retains only
the matching session's aliases after rebind. Extension tests check another request/session,
unproved ownership, anonymous custody, permission revocation and bounded inspection failure.

## Validation

The verification checkout was captured at 2026-09-19 08:26:22.734 UTC from base
`2d87e689a905d6e6be35d0f0ec55483cf5c83e62`, with the shared working changes copied as explicit
bytes. No copied file changed during capture. The checkout uses the existing dependencies and
limits Vitest to two workers; test selection is unchanged. It has its own build output and never
installs or restarts the running app. The capture manifest is `verification-snapshot.json` in
the ignored audit directory.

* `npm run verify` passed: 5,334 suite tests and all six separately executed shutdown tests,
  45 skipped. The same command passed ripgrep staging, public-history privacy, notices for
  153 production packages and seven catalog entries, 730 native source archives/patches,
  TypeScript and Electron module loading. Log: `verify-complete.log`.
* The focused Unattributed suites passed 234 tests covering plans, workspace/process custody,
  code-mode MCP and workers. The paired HTTP bridge ownership suite passed all three tests.
  These are overlapping focused checks, not additional tests to add to the full-suite count.
* `scripts/verify-browser-control.mjs` passed all 24 check groups through production broker
  and extension backends in isolated Chromium. This includes protected-page read-only reviews,
  scoped/opaque-document reads, trusted input, actual iframe input, image geometry, screenshot
  authority after inspection, diagnostics, dialogs, navigation, request-to-session adoption and
  worker reconstruction. The foreground sentinel stayed selected. Results: `chromium-final/`.
* `scripts/verify-browser-control-entry.mjs` passed seven checks using the production MV3 entry
  graph, actual popup pairing, alarm/wake transport, tab discovery across two windows, attach,
  explicit new-tab creation and unpair. It reported no worker errors. Log: `browser-entry.log`.
* The Windows production helper dispatcher and Window2 tests verify partial capture results and
  retained semantic actions without stale pixels. Helper tests substitute OS input/capture
  entry points; they are not a claim of native macOS/Linux acceptance.
* `npm run build` and the verification checkout's `git diff --check` passed. The build retains
  Vite's existing mixed static/dynamic import warnings. Log: `build-final.log`; compiled output:
  `verification-tree/out/` within the ignored audit directory.

The new scripting path initially rejected a real document ID because it incorrectly expected
a page-style UUID. That was corrected and verified against Chromium, not just mocked IDs.
Chrome's scripting API describes `documentId` as a string; its spelling is preserved exactly.
See [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting#type-InjectionResult).
A test-local binding shadow in the new bridge test and an incorrect fixture assumption that
explicit self-detach always emits a notification were corrected before final acceptance.

Two earlier full-page captures exceeded the existing 20-second timeout. The final fixture releases
its auxiliary service-worker debugger after setup and reacquires it only for lifecycle checks;
it does not raise the production timeout or skip screenshot coverage. Final viewport/full-page
capture times were 1,327/13,861 ms. The exact timeout cause is not established, and this audit
does not claim a general screenshot speedup. The returned viewport image was also inspected.

Other chats continued changing history/renderer work while verification ran. The audit's
production files were compared with the verified snapshot; unrelated later changes remain
owned by those chats. Full-suite/build evidence describes the frozen checkout, not an assertion
that all later concurrent changes were included. Only the browser verifier's auxiliary-debugger
lifetime change was refreshed after the full-suite capture, then separately exercised in Chromium.
The final SHA-256 comparison matched all 20 selected audit source/test/verifier files against
the checked snapshot. Main/preload/renderer build outputs exist, the scoped final diff check
passed, and no Chromium processes from these audit profiles remained. Evidence: `final-check.json`.

One live Core `agents` status invocation returned `Tool agents not found`; local MCP worker tests
passed. One verification launch received an indeterminate gateway refusal before execution; an
identical direct retry was admitted. Neither response established Read-only mode. No installed
connector snapshot, signed-in provider behavior or native macOS/Linux execution is claimed.

## Disposition of other observations

Patch context mismatches and incomplete patch envelopes remain explicit failures; no speculative
rewrite of authored source or missing patch text is introduced. Code-mode failures from calling
another connector's tools remain surface errors; successful already-dispatched work must not be
replayed. The existing bounded output guidance and truncation preview remain in place.

The native key-parser/double-observation candidates were source-review findings, not observed
failures in this sample. Concurrent native-focus changes belong to the other active work lane.
This audit preserves those changes and does not claim them as new implementation here.

No version bump, package installation, app/extension restart, commit or publication is part of
this audit. The user's running application stays under its existing lifecycle.
