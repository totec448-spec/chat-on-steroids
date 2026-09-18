# Duplicate response turns and unwanted Continue recovery

## Observed failure

One native question and one finished response were recorded under two overlapping
document-local generation IDs. The canonical final retained the first document's
turn, while most of the 99 MCP calls belonged to the second. Sorting independent
turn groups placed those calls below the final. Recovery also looked for completion
of the second fragment and incorrectly filed an ordinary Automatic Continue input.

Goal was off. Automatic Continue was independently enabled. The erroneous input
named a tool-injected correction as its native question even though that correction
had no native user bubble. One silence reload and two subsequent pickup reloads
were confirmed. No Send authorization or delivery receipt exists for that Continue;
the retained live outbox now marks it cancelled.

The signed-in page was inspected again. Its native question and final UUID match
the canonical recording; the composer is empty, Stop is absent, and normal response
actions remain present. The two pickup-reload notices are still visible. These are
observations of the installed build, not acceptance of a newly installed patch.

An id-less New Chat document navigating into an existing running conversation could
start another local generation before receiving the recorded owner. A deterministic
DOM regression reproduces that opening race. The preserved incident proves the
duplicate identities and their consequences, but does not establish the exact
navigation gesture that originally produced the second document.

## Implementation

The store derives response identity from its existing timeline and request records.
Each local turn retains its native question and first recorded end. Only an exact
request spanning overlapping turns for the same native question can join them.
A different request already associated with either response prevents joining;
new questions, nonoverlapping retries and contradictory conversation evidence stay
separate. The earlier response is projected through `responseTurnId`. Cold history
reconstruction replays minimal identity records in original canonical order.
Original journal events, turn IDs, timestamps and sequence numbers are preserved.

Native browser inputs and tool injections remain distinct. `inputId` alone cannot
identify an injection because native app-delivered questions carry it as well.
Only the recorded tool-input identity or a known local turn proves an injection.
These corrections remain in history while being excluded from native question
anchors and recovery question selection.

The recorder and completion reader consume the same response relation. A native
final observed in one document settles its proven sibling fragment. The browser
receives the recorded question alongside the open turn and consumes an already
matching Send receipt during adoption. New Chat navigation resolves existing
ownership before observing the hydrated question; exact new Send receipts retain
their ordinary opening path.

Additional checks exposed two completion/display races. A parallel read replacing
the session queue promise invalidated a known final despite no history change.
Completion now checks the actual committed sequence and conversation binding across
the disk read. Genuine question/rebind changes still invalidate the snapshot. An
initial serialized-read approach conflicted with existing mutation-race tests and
was replaced with this smaller correction; those tests remain unchanged and pass.

Incremental display also retained old response origins on already resident rows.
Both chronology consumers now apply the newly proved earlier origin consistently
to rows naming that exact local turn. The browser DOM regression proves that both
tool groups precede the preserved native final after an incremental identity update.

## Verification

New failing regressions were observed before their respective fixes: duplicate
response completion, New Chat adoption, late old requests during a new response,
concurrent completion/activity reads, conflicting conversation evidence, and
incremental placement of tool rows below the final.

The focused run passed 72 tests across `recorder-final-identity`,
`session-response-identity`, `session-completion-order`, `chronology`, and
`completion-input-integration`. The existing disk-read question/rebind races passed
without changing their expectations. A separate DOM run passed the incremental
placement and desktop/browser chronology parity checks.

The private recording was copied into isolated state. Replay found all 99 calls
before the final, recognized completion for both document fragments, preserved
the native question and refused a new Continue. Restoring the erroneous unsent
ticket into the isolated outbox cancelled it and left no pending pickup. SHA-256
checks confirmed that the source and copied journals were unchanged.

`verify-history-scroll.cjs` replayed that canonical snapshot through the production
Electron renderer: 105 of 105 message/tool rows, no missing or duplicate rows,
no order changes across paging or idle refresh, and zero measured viewport drift
at the recorded paging boundaries. Its screenshot was inspected.
`verify-overwrite-layout.cjs` passed all 18 width/zoom/fold configurations, including
native final controls and restoring native layout when Overwrite is disabled.
Its screenshot was inspected too. These isolated fixtures do not prove signed-in
provider execution with an installed replacement build.

The final `npm run verify` passed: 5,273 tests in 212 passing suites, with four
suites and 45 tests skipped, followed by all six isolated shutdown tests. Type checking,
public-history privacy, dependency notices and native-source inventory checks passed.
The final `npm run build` passed. Vite retained its non-failing mixed static/dynamic
import warnings. `git diff --check` passed.

The final command also repeated the isolated original-recording/outbox replay after
the completion snapshot correction. Validation logs, replay JSON and screenshots
are retained under the ignored `.tmp/chat-final-diagnosis-20260918/` directory;
the renderer screenshot is under `.local/`. The first full validation of the
serialized-read attempt failed its two existing disk-read mutation cases. The final
run above follows the smaller sequence/binding correction and has no failures.

## Reference checks and deployment

Chrome's [navigation documentation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)
distinguishes document identity from frame identity and does not define ordering
between navigation and network-request events. Its
[content-script documentation](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
describes isolated execution contexts. React's
[state-identity documentation](https://react.dev/learn/preserving-and-resetting-state)
explains why retained or replaced render-tree positions are not durable response
identities. These references support the identity boundaries, not the incident's
specific causal timeline; that evidence comes from the recording and regressions.

The installed extension mirror and source still differ in their content, Fiber and
DOM-adapter files despite declaring the same application version. No installer,
running application payload or live state ledger was replaced. No commit, push or
release was performed. Private session snapshots and screenshots remain in ignored
local scratch directories. Unrelated shared-tree changes were preserved.
