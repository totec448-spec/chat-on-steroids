# Follow-up delivery and delayed final capture

## Findings

The affected continuation was never claimed by a browser and never authorized for
Send. Its durable cancellation reason was `a local tool is running`. The source
treated the conservative in-flight count, which includes unassigned requests from
other chats, as permanent evidence that this recovery source had resumed.

The outbox now separates source invalidation from temporary delivery admission.
Running or settling calls hold Stop/Send while preserving the frozen continuation.
Recorded new source work, another question, a final, Stop, Block, changed ownership
and disabled recovery still invalidate it. The existing claim and one-use Send
authorization are retained.

The subsequent screenshots showed a native final while the desktop still displayed
activity and offered tool injection into that old turn. Logs confirm that the final
was captured only after the later silence reload. The three failed messages had
explicit tool-delivery custody for the old turn; the later browser-delivered message
was claimed in 242 ms and acknowledged in 5.7 seconds.

The same logs repeatedly show readable page-model evidence immediately after reload,
then loss of that evidence. Chrome was loading the unpacked extension from the shared
source directory while those files were being edited. Repairing only `fiber.js` can
mix a newly read helper with Chrome's cached isolated recorder. The original failed
document's precise pair of running protocol versions was not captured. A production
content-script regression reproduces this mismatch and its effect on Continue.

`repair_fiber` now uses the existing recorder restoration owner to install the DOM
adapter, MAIN helper and matching recorder in the exact requesting document. Its
document/epoch custody is checked after each asynchronous step. The healthy-recorder
version guard retains an equal current instance; an older recorder is replaced.
This introduces no new reload timer or outbox and does not loosen native-final checks.

## Verification

The 12 input cases first failed on the old cancellation rule, then passed. Four
document-repair cases first failed on the helper-only implementation, then passed.
The two content-script cases distinguish cached helper-only failure from successful
paired recovery with one native Send and acknowledgement. The neighboring final,
new-work, source-identity and one-use Stop/Send checks remain covered.

The completed full `npm run verify` passed 5,448 tests with 45 skipped, followed by
6 passing shutdown tests. Total: 5,454 passed. Privacy, notices and typechecking
passed in that command. `npm run build` and `git diff --check` passed.

The Windows x64 package and the packaged native-runtime smoke check passed.
Installation completed with exit 0 and the application reconnected. All 288
packaged files and 17 stable-extension files matched the checked package, with no
hash mismatches. The user confirmed reloading the companion extension.

Private logs, session identities, package/install receipts and acceptance evidence
remain under the ignored `.tmp/followup-failure-20260919/` directory. No public
release, commit or GitHub message was made for this change. Unrelated shared-tree
changes were preserved and are not claimed as this fix's implementation.

## Live acceptance

Live acceptance passed in the signed-in Chrome browser with the newly installed
application and reloaded companion. The test conversation read the local probe
and emitted `COS_FINAL_SYNC_OK_20260919`. The provider made three reads, including
two initially unassigned calls subsequently attributed to the exact conversation;
this is not a claim that first-call attribution was immediate. The final itself
was recorded at 17:37:38 UTC and the turn became completed with no active turn.
The named CoS tool row appeared in the browser, and the exact final was visible
in the Electron transcript.

A second prompt was entered and sent from that existing chat's actual desktop
composer after completion. The browser claimed it in 199 ms and acknowledged its
native message in 979 ms. Its canonical user row records confirmed input delivery.
The resulting `COS_FOLLOWUP_OK_20260919` final was captured at 17:42:08 UTC. Both
native final messages have stable provider identities and distinct owned turns.
The same open desktop view updated to show the second final, `Worked for 21s`,
and the ordinary Send button without a stale active state or reload countdown.
No browser reload or repair occurred in the test conversation; the browser page
identity remained unchanged across both responses. No new page-helper degradation
was present in the inspected log after the companion refresh.

This verifies actual final capture and desktop follow-up delivery after deployment.
It does not retrospectively establish the exact version pair in the original
failed document or substitute for an exhaustive long-running provider test.
