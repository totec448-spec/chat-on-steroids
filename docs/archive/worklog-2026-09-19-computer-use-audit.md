# Native Computer Use audit, 2026-09-19

The requested scope is Windows native Computer Use in CoS. A concurrent task owns Browser Use.
This work adds targeted native observations and useful failure recovery while retaining exact
window identity, input ownership, frame generation and live permission checks.

## Evidence and scope

The local audit selects the 40 latest updated tool-bearing main sessions started before this
task began, with a frozen cutoff of 2026-09-19 09:02:03.676 UTC. The sample begins on September
17 at 16:05:00.354 UTC. Worker and unattributed sessions are excluded from the main count;
five contemporaneous unattributed calls are checked separately. Calls are deduplicated by
call ID across journal/materialized records. Full argument/result assets are read, rather
than relying on truncated event previews. Extraction reported zero malformed records,
missing assets or truncated asset fallbacks.
An independent date-bounded scan of both runtime logs found exactly the same 13 native errors
and the same code distribution. No additional native tool errors appeared in that log window.

There are 6,482 main-session tool calls, including 138 native Desktop calls. All 138 native
call arguments, outcomes and observation metadata were reviewed in sequence, with surrounding
messages and full error results for the failures. Successful native input is evidence of tool
acceptance, not proof that every application-level goal completed.

| Native operation | Calls | Recorded errors |
| --- | ---: | ---: |
| `list_windows` | 44 | 0 |
| `get_window_state` | 68 | 6 |
| `press_key` | 11 | 5 |
| `click` | 10 | 2 |
| `list_apps` | 2 | 0 |
| `type_text` | 2 | 0 |
| `perform_secondary_action` | 1 | 0 |

The 13 errors comprise five `CAPTURE_FAILED`, three `WINDOW_NOT_FOUND`, two
`BROWSER_TAB_CHORD`, one `FOCUS_FAILED`, one `STALE_FRAME` and one `STALE_WINDOW_STATE`.
Recorder outcome `tool_rejected` includes these operational failures and does not by itself
mean tools were disabled. Seven of the 24 input calls failed. Of 48 successful observations
requesting UI text, 41 reported an incomplete accessibility tree.

The actionable patterns were repeated capture of a minimized target; reuse of handles after
dialogs closed or the application restarted; coordinate input after a window changed size;
and repeated first-page UI trees with no public filtering path. An assistant response also
incorrectly generalized a target failure into global read-only capability. Browser chord
policy errors belong to the separately maintained browser workflow, not a native permission
bypass.

Full private evidence, extraction/review scripts and the sample manifest are under ignored
`outputs/computer-audit-20260919/`. They are not release or repository assets. The extracted
call corpus SHA-256 is `17802cd7a9e22bf2a7ee459246cda5d063c2c7407bc9a1e9dd22c0987bab320e`.

## Changes from this task

`windows-api.ts` retains the observed window state in returned Window objects. A model can
see a minimized window before requesting pixels. State is observation metadata, never an
input authority or replacement for the current native identity check.

`get_window_state` now accepts `query`, `role` and `max_elements` (1–100). Query matches native
control name or automation ID; role matches control type. Filtering occurs during the bounded
UIA traversal, so controls beyond the initial 100 can be located. Search options imply UI
text when `include_text` is omitted; explicitly disabling text with search options is rejected
before changing cached observation state. Filtered results have fresh numeric indexes.

The native helper retains semantic controls with no drawable bounds when they advertise an
action. Previously an invokable control could disappear solely because its rectangle was
empty. Such controls have no image bounds/center and never supply document text. The existing
physical click fallback still requires valid bounds. Actual UIA invocation, current-root
validation and disabled-control checks remain authoritative.

Native operational failures now return the original message, underlying code, nullable exact
completion evidence and a concrete next observation. A stale handle points to `list_windows`;
stale coordinates/indexes to a new state; unavailable pixels to text-only inspection or an
explicitly needed restore. Recovery does not dispatch input, automatically retry a click or
invent zero completed actions. The model instructions distinguish target failures from global
tool permission and require inspecting current state before deciding what remains to do.

Literal plus keys/chords (`+`, `Control_L++`, named `plus`) use one parser for native input
and browser chord policy. Malformed chords fail before consuming state or sending input.
Tool descriptions, Windows instructions and the owning AGENTS section document these changes.

## Existing work preserved

The shared working tree already contained focus thread-attachment fixes, request-to-session
observation adoption, combined screenshot/UIA partial-result handling, and browser chord
recovery wording. This task builds on and verifies those changes; it does not claim to have
introduced them. Other dirty files and the parallel browser task are preserved.

## Verification

Red reproduction established that the facade omitted minimized state and rejected valid literal
plus chords; inspection found no public targeted-search arguments. An owned real WPF/UIA fixture reproduced the
loss of an invokable zero-bounds control. Its existing collapsed-document test then caught a
regression in the initial fix; requiring drawable bounds for document-text selection corrected
that regression while retaining the semantic control.

The first focused run passed 38 tests, including real Windows UIA invocation, filtered traversal
beyond 100 controls, focus attachment ownership, native input release and failure recovery.
A subsequent transport/API run passed 68 tests with seven platform branches skipped. Typecheck
and `git diff --check` passed. These focused runs overlap; their counts must not be added.

The first full run identified an oversized discovery description and two incomplete mocked
controls in the Code Mode wire fixture. The description was shortened without raising the
schema budget; the fixture now supplies native bounds and PNG dimensions. All three affected
cases passed their targeted rerun and both affected test files passed in the final full gate.

`node scripts/smoke-windows-desktop.mjs --software-fixture` passed against the actual Windows
capture/input helper and actual Electron Window2 facade, using only owned test windows. The
WPF fixture uses software rendering; Windows.Graphics.Capture itself remains the production
implementation. Assertions cover a covered target, popup ownership, preserved foreground,
targeted search returning a fresh actionable index, semantic and coordinate invocation, and
literal/multiline input. The result reports one paste, zero Enter key events, restored clipboard,
excluded unrelated windows, and explicit minimized-capture failure. Capture measured 361 ms
in this run; that single fixture measurement is not a general performance claim.

The final `npm run verify` completed with exit 0 on the frozen verification tree: 5,380 tests
passed with 45 skipped, followed by all six separately run shutdown tests passing. That is
5,386 passing tests in the complete gate. Public-history privacy, license notices, pinned
native-source checks and TypeScript validation also passed. `npm run build` then completed
with exit 0; Vite retained its existing mixed static/dynamic-import warnings.

The snapshot starts at HEAD `2d87e689a905d6e6be35d0f0ec55483cf5c83e62` and preserves the shared
working changes. Its only test scheduling difference is a limit of two Vitest workers.
After the initial full run, only the shortened Desktop description and corrected Code Mode
fixture were refreshed before rerunning the entire gate. A comparison against all currently
modified/untracked repository files and HEAD confirmed identical source/test content; only
this final report differed before being copied back to the evidence tree.

Reproducible evidence is in `outputs/computer-audit-20260919/verify-final.log`,
`build-final.log`, `native-smoke.log`, and `verification-snapshot.json`. The initial failing
run remains in `verify.log`. Raw chat/runtime evidence remains in the adjacent private files.

No installation, installed-app restart, commit, push or release is part of this task.
