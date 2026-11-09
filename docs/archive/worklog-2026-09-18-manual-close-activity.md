# Manual tab departure and ongoing turn recovery

The reported Foldcraft sequence lost Active/Generating and injection after the user closed
the Chrome tab, even while exactly attributed MCP calls continued. Its later silence recovery
was consequently never delivered. Timeout notices also appeared twice with and without the
native Retry button label, and resumed work hid the acknowledged reload receipt.

## Change

`/closed` keeps the existing activity grant, qualified pickup clocks and completed repair
receipts. The durable departure marker only suppresses immediate page repairs. Existing
silence, queued/Goal and compaction recovery still validate the original source and their
normal deadlines before reopening. Stop, final, block, supersession and pre-action claim
checks retain their authority. New exact MCP calls renew activity without pretending that
the browser has returned; exact running ownership also lights the chat before a result arrives.

The sidebar's shared activity predicate no longer interprets browser `endedAt` as turn
completion. Recorder and renderer share recoverable-error text equality, including the Retry
button variant, without rewriting original history. A confirmed reload uses the existing
accent color and remains visible when tools resume. The notice explains the error reload
budget and silence fallback; a completed turn alone receives the resolved treatment.

## Verification

Five initial regression cases failed on the previous behavior: offline worker activity,
normal/Pro activity after repeated close, recorder Retry deduplication and notice deduplication.
A separate admitted-running-call regression also failed before its projection correction.
The isolated HTTP fixtures cover exact request reuse with no page observations, normal/Pro
silence deadlines, revoked old handouts, newer page return, and real final handoff to Goal/Loop
with Continue cancelled. The latter uses the existing production IPC/input hooks, including
Off mode where no Goal is generated.

The initial affected-suites run passed 1,107 tests in 11 suites and the build succeeded. The
following full verification found 13 failures in the concurrently changing shared tree. On
rechecking the latest sources, 11 already passed. The remaining two expectations were corrected:
the broker now writes snapshot version 7, and an optional attribution-recovery notice is not
required for a successful request-owned read/inbox operation when no browser incident is eligible.

## Overwrite follow-up

The user additionally reported redundant `prime` labels and native status summaries interleaved
with useful local tool rows. The specified Coding Task Continuation chat was inspected visually
in its collapsed and expanded Worked views. The extension now omits `prime` badges from all
companion stream rows while keeping worker labels and internal attribution.

Plain native tool-status captions without thought metadata are suppressed only inside an exactly
owned response with mounted canonical local tool calls. The DOM adapter preserves interactive
native disclosures, links, prose, media and unrelated adjacent controls. Existing typed-thought
and exact connector coverage retain their original stricter proof. Off, navigation and loss of
response ownership restore native content. The regression failed before the fix; a separate
icon-only adjacent-button case also failed before narrowing the ancestor suppression.

Browser DOM/live verification remains limited: the Desktop browser connector refused the active
orchestration tab, and the separate plugin browser navigation and snapshot timed out. No protected
browser guard was changed. The fallback is verified against isolated DOM fixtures, not claimed as
confirmed in the installed extension. No page snapshot was saved by the abandoned native Save As
attempt. No application installation or restart was performed by this task.

Other concurrent working-tree edits are not part of this task's change list.

## Completed shared-tree verification

The final `npm run verify` completed on 2026-09-18 at approximately 01:08 local time.
The log `.tmp/unattributed-verified-20260918.log` records successful privacy/license checks,
TypeScript checking, **5,167 passing tests with 45 skipped in the main run**, followed by all
**six passing shutdown tests**. There are no failing test suites in that run. Earlier logs
with instruction/schema assertion failures describe superseded intermediate working trees.

The subsequent shared-tree `npm run build` completed successfully at 01:08:45. Its log is
`.tmp/unattributed-build-20260918.log`, with explicit exit code `0` in the corresponding
`.exit` file. The renderer and main-process outputs were both produced. The mixed dynamic/static
import notices are build warnings, not a failed build. This task's redundant build invocation
was blocked before execution; the independently completed shared-tree build above is the
verification evidence, rather than an assumed result of that blocked invocation.

Final `git diff --check` also exited with `0`. Build output SHA-256 fingerprints read after
verification: `out/main/index.js` =
`f41d9ae636f35f166ece20c2acaca9f14e2d2c5c0da88304f846c0784434502f`;
`out/renderer/index.html` =
`6f27d798f4dee2fa582bd2201ee542ddc9aef424a82c455a4f8251138d689fcd`.

During final visual review the installed CoS window was observed through the Desktop connector.
It still belonged to the installation started before these source changes. Both listed
ChatGPT tabs were protected executor conversations, so neither was closed or reloaded for a test.
A separate built-renderer probe with synthetic IPC failed to load its fixture chats. A second
launch after correcting the fixture was blocked by the tool, so no successful visual result
is claimed and the unverified probe was removed from the source tree. The HTTP/IPC and renderer
regression suites above remain the evidence for the fix; an installed-app end-to-end close/reopen
exercise is still unverified. No installer, application restart, extension reload, commit or
publication was performed as part of this continuation.
