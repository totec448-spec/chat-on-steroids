# Follow-up queue after delayed completion reporting

## Report and reproduced boundary

The follow-up report describes an intermittent existing-chat message stuck at Queued.
Sending a message in Chrome can unblock the desktop app. Other attempts work while the
browser is inactive. The reporter's delivery option and installed payload were not captured.
These observations do not establish that every failure is caused by background scheduling.

The production recorder/bridge/outbox integration reproduces a distinct ordering failure:
the native answer finishes, a desktop after-turn input is admitted while its turn is still
recorded active, then the browser delivers its delayed final and completed turn. The app's
input policy correctly becomes settled and browser-allowed, but eligibleStageEnd rejects
that completion because its original browser timestamp predates the input's createdAt.
The queue remains pending until another eligible completion. Finish checkpoints have the
same defect. Ordinary auto delivery passes this reproduction.

## Change

The existing outbox records queuedTurn, an optional bounded conversation/turn reference,
from the admitted session before asynchronous readiness checks. If a native UI end has
already arrived without the final, the bridge's existing exact MCP-backed activity grant
supplies that reference. Possible or unassigned activity cannot do so. Generated finish stages
inherit that reference. eligibleStageEnd accepts the completed turn the input was queued
behind despite delayed reporting, while preserving the current settled-state check.
This reference is queue intent, not an independent owner of turn completion.

The same browser claim, final Send authorization and native-message receipt remain in use.
One consumed completion cannot release a second queued message. Cancellation, running tools,
a new active turn and a different conversation still prevent the delayed source from sending.
An answer already recorded before admission is not newly eligible. Legacy rows without the
reference retain their existing conservative timing rule; source identity is never invented
from a screenshot or migration guess. Explicit tool injection retains its separate semantics.

No extension lifecycle, polling, browser focus, retry or recovery policy is added by this change.
The previous background-rendering fixes and unrelated shared-tree changes remain intact.

## Validation

Before the production edit, the integration reproduction failed for after-turn and finish
and passed for ordinary auto delivery. After the change, both complete the existing claim,
single-use authorization and exact receipt path. Coverage includes input-store reload,
repeated final publication, a second queued checkpoint, running tools, already-recorded
completion, cancellation, a different turn/frontend, and legacy rows without source proof.

The same failure was also reproduced when the UI end arrived before the final and the exact
work grant remained active. Both event orders now pass, alongside the existing explicit-image
injection identity check. There are 13 added regression cases. The final full verification
includes 190 passing input-owner tests and 259 passing recorder/bridge integration tests.

Final `npm run verify` passed: 5,527 tests plus six isolated shutdown tests, 5,533 total,
with 45 skipped. TypeScript, public-history privacy, dependency notices and pinned native
source checks passed. `npm run build` completed with exit 0 for main, preload and renderer;
the existing non-fatal import/chunking warnings remain. The scoped `git diff --check` passed.
Command evidence is retained in `.tmp/followup-queue-verify-final-20260920.log` and
`.tmp/followup-queue-build-final-20260920.log`.

The signed-in maintainer page was inspected without disturbing its active generation.
The delayed transport order is reproduced through the production local bridge with synthetic
events in isolated test storage, not by altering a live session ledger or the reporter's account.
No installer, commit, public message or release was created. The reporter's live acceptance
remains unverified, including whether the affected messages used after-turn/finish delivery.
