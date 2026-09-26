# Cold-source compaction and Stop notice

## Reproduction and first wrong boundary

The installed Internal build failed after opening a closed, settled conversation
for a manual Compact & Resume. A separate diagnostic conversation reproduced it.
Debugger observation showed the composer ready while the latest question was
still absent. Once native history mounted, `sameSource()` became false; no Send
dispatch was authorized. The generic readiness error wrongly said the ticket
was waiting for recovery even though this source-change branch abandoned it.

`/activity.recordedQuestionId` deliberately describes an active turn. An idle
source has no such turn, and cannot use that projection as its history-readiness
anchor. The exact compaction ticket now returns the latest recorded native user
message identity from the existing bounded history reader. Binding and ticket
identity are rechecked after that read. The existing page waiter consumes this
anchor before freezing source identity; Send/dispatch/receipt authority is
unchanged. A real source change now reports that refusal instead of claiming a
pending retry. No new timer, retry loop, durable field or host behavior was added.

The initial desktop request reuses recovery transport to reach its source. Normal
preparation no longer publishes a recovery incident. Actual action failures and
later recovery episodes retain their existing progress path.

Stop notices now record only the historical request and finish-hold release.
Readback normalizes the exact old app-owned sentence without rewriting history
or turning page idleness into provider-side cancellation confirmation. Native
Stop, its command lifetime and turn authority are unchanged.

## Checks

- Mainstream: 198 selected compaction/handoff/Stop cases passed; one old assertion
  required the removed permanent-pending wording. Updated that assertion and ran
  all 38 session-finish cases successfully. An earlier diagnostic assertion had
  an off-by-one string-length expectation; corrected it and the focused run passed.
- Internal: typecheck and 11 focused cold-source, preparation, Send-fence and
  legacy-notice cases passed. Mainstream typecheck also passed.
- Cold-source coverage includes an already-mounted editor with delayed settled
  history, no insertion/dispatch before the exact question, and exactly one Send.
  Existing hydration navigation/user-change and Send-readiness guards passed.
- New installed-package acceptance is pending below; no full verify, commit or
  push is claimed. Temporary diagnostic scripts and private session data remain
  outside both repositories.


## Installed acceptance

The final Internal Windows x64 package and native-runtime smoke passed.
Installer SHA-256:
`649823D2E612A40027F7525E8DF37968598E83D17E22CCDECD7F00C1DC38277E`.
Installed app.asar matched the package:
`37AE6954B91B26EECBCC07FC0E59FB00A9D1274B552E566361CA77B21C7AC980`.
The running profile's content script matched packaged source. Installation was
performed after normal shutdown; no configuration/history ledger was edited.

A final cancellation-during-readback regression passed. The ticket/owner check
runs after both async reads so a cancelled ticket cannot publish stale preparation.
The five corresponding Mainstream bridge cases passed and typecheck passed.

Live acceptance on the authorized remote notebook started with no source tab.
Invoking Compact through the installed desktop API opened the exact source,
waited for the recorded idle question, submitted one source request, captured
the brief, committed the same session to the destination and recorded the new
assistant's final response. No preliminary user message was sent. The new run
created no recovery progress row; old diagnostic failures remain historical.
The desktop showed the successful compaction card, Send state and the normalized
historical Stop notice without the stale pending disclaimer.

A separate late marker-reconciliation warning was observed after commit:
the destination checkpoint remained dispatched-unresolved when the already
committed transaction rejected late message binding. The destination response,
turn completion and recording were verified in both the native page and CoS.
This warning is not claimed fixed by the cold-source change; no broader
continuation rewrite was folded into this patch.

Both repositories carry the same fixes/tests, preserving their existing
Internal host differences. No full verify, commit or push was performed.

## Follow-up: ACK before destination marker

The observed warning came from a legitimate ordering: the command ACK committed
B before the marked user-message observation reached the continuation owner.
The binder rejected any new receipt once committed, even though its existing
dispatch checkpoint still needed that exact message identity.

The same serialized checkpoint owner now admits this refinement only for the
committed WAL destination and an already-dispatched unresolved send. It cannot
reopen the transaction or Send. Conflicting chat/message identities, aborted
tickets and never-dispatched sends remain refused. Conversely, a known message
receipt prevents a command ACK from committing another destination. No new
protocol field, timer, recovery branch or browser-host change was introduced.

Mainstream continuation and bridge suites passed all 626 cases. Internal passed
the ten focused receipt/race cases. Typecheck passed in both. Coverage includes
ACK-first, marker-first, concurrent commit/marker, restart, durable-write failure,
conflicting identities and the resulting activity bootstrap projection.
These follow-up source changes are not yet in the installed package described
above; new package/live acceptance and final verification remain pending.

## Follow-up validation and package

The final Mainstream verify passed privacy, notices and typecheck. Its broad
suite finished with 6,134 passing, 46 skipped and two failing renderer-state
cases (Setup connection and a rejected port's queued save). The isolated rerun
passed all three selected variants without changing source or tests. The
separate native/shutdown phase passed 26 cases. This is not a fully green
single verify invocation; contention is suspected, not established as the cause.

Internal packaging and packaged-native smoke passed. The packaged main equals
the generated main and contains the receipt correction. Installer SHA-256:
`5E361A8919CBB5C48CF724C3502C59F6F3B03AC91E1393C65C385217C26A6ADA`.
Installed app.asar matches packaged SHA-256:
`56D86CCDF7C37CA770FEEDAC5C9D598DA6F8F356179763F1913A346077CB8DB8`.
The remote installer hash matched and installation returned zero with CoS closed.
No profile/history ledger was edited. Installed acceptance follows below.

Installed cold-source acceptance passed: the source tab was absent, one summary
request was sent, and the same local session moved to its new destination. The
real ACK-first race occurred again: commitment preceded marked-message
reconciliation, which now succeeded and durably completed the exact destination
receipt. Source and destination checkpoints both became sent; the assistant's
final and turn end were recorded. No new preparation/recovery notice was shown.
An older already-retired marker reported unknown continuation on source hydration;
it did not block the new transaction and is not claimed repaired by this change.

A subsequent authored message through the desktop composer was confirmed once,
answered and settled normally, retaining its delivery check. A bounded generation
was then stopped through the composer. The native page reported no generation
or Stop control and the response stopped mid-line before its requested length;
CoS cleared Stop pending and returned to Send. Its native terminal was recorded
as completed, so this test establishes observable interruption and control
settlement, not a provider cancellation classification. The historical Stop
notice retained only the request/release wording.

A second Compact started with its source tab already open and also completed:
one source request, one new destination, both exact send receipts, the same local
session, a recorded final and no pending Stop or compaction error. Temporary
diagnostics remained outside the repositories. The installed app was left idle.
Source/test parity and diff whitespace checks passed in both repositories;
Internal-specific host and test-mock differences were preserved. No commit,
push or PR edit was performed.
