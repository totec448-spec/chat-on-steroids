# Automatic Continue and composer recovery audit

## Recorded behavior

Reviewed two interrupted-response recovery episodes in the same durable session,
including its intervening Compact & Resume. Both automatic Continue deliveries
recorded the native source turn's interrupted Stop before Send authorization and
the new native message receipt. Neither old request made another recorded tool call
after its automatic Stop. Repeated browser claims retained the same input ID and
document owner; they were not duplicate messages.

The reported episode contained two confirmed reloads: the assistant-error repair
and the later silence repair. There was no third reload to send Continue. Its gap
between reloads was three minutes because the existing awaiting-return safeguard
extends the silence deadline while no new work has proved recovery. This protects
a large page still loading after a reload. The subsequent busy wait was one full
minute from the silence reload acknowledgement. Browser pickup and Stop processing
followed that deadline; the deadline is permission to proceed, not a promise that
the message is already sent.

A separate manual Stop in the reviewed session was followed by additional calls
from the same request. Native Stop confirmation must not be described as a server
execution fence. Current Stop disables automation and requests native termination;
Block owns local-tool refusal. These distinct semantics were not changed in this
composer fix. Private session IDs, message text and raw logs remain outside the repo.

## Corrections

The app projected a shared wait twice: the recovery row and the Goal/Loop lifecycle
each displayed the same deadline. The renderer now suppresses only the duplicate
lifecycle display when the corresponding recovery row is visible. Automation
controls, unrelated cards, different deadlines, pickup and attribution remain.
Backend deadlines, browser waits and delivery ownership are unchanged.

Automatic Continue intentionally shares the durable outbox and its single-send
receipts. Its recovery source permits delivery without a canonical final and owns
the conditional Stop. Previously the composer presented it as an ordinary queued
task, with misleading after-final text, editing and drag reordering. It now has an
Automatic Continue label, an explanation of its delivery condition and its existing
cancellation action. Main-process edit/reorder operations exclude recovery rows,
preserving the frozen text and source even if called outside the renderer. Authored
queue reordering still works when a recovery row is present.

After Continue started, removing its live countdown could reveal the previous
reload receipt again for the remainder of its two-minute display age. The composer
now retires that fallback after a newer native question or turn in the recorded
chronology. A genuinely new repair still appears; developer history is retained.

## Verification

All nine initial regressions failed before the fixes with the expected production
behavior: duplicate countdowns, unlabeled/editable recovery input and a resurfacing
reload receipt. A later history assertion was corrected to respect the existing
developer-mode history visibility, and now covers both display modes.

The isolated Electron fixture in `scripts/verify-input-queue.cjs` passed 13 checks,
including the existing message editor/upload cases and new recovery behavior at
1100- and 640-pixel window widths. Captures were visually inspected. Automatic
Continue remains cancellable, the shared wait has one timer, and a distinct Loop
deadline retains a second timer. Local artifacts are under
`.tmp/message-send-20260918/ui`; the fixture uses isolated user data and no provider.

The four targeted suites passed together: **601 tests** across the renderer timeline,
recovery labels, input owner and input-delivery integration. The latter includes
normal/Pro recovery, exact Stop ownership, Send authorization, newer-work cancellation
and Off/Goal/Loop behavior. TypeScript passed.

`npm run verify` passed: **5,295 tests passed and 45 skipped** in the main run,
then **6 passed** in the required separate shutdown run. Privacy, dependency notices,
native-source metadata and TypeScript checks passed. Total for this gate: **5,301
passed**; the targeted run is overlapping coverage, not additional unique tests.

During final review, the receipt condition was narrowed to a different turn ID so
reopening the original source preserves its recent reload receipt. Both display-mode
tests first reproduced that edge; all seven focused renderer regressions then passed
after correction. The subsequent production build passed with this final source.
Build output retained the existing mixed static/dynamic import warnings. Local gate
and build logs are `.tmp/continue-dock-verify.log` and `.tmp/continue-dock-build.log`.

No live application restart, installation, Git commit or publication was performed.
