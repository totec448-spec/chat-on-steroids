# Stop intent, MCP activity and late final answers

## Reproduction and evidence

An observed conversation recorded an app-authored Stop request and then an extension stopped
event. The same exactly correlated request started more local calls after that event. A later
manual page reload revealed the final assistant answer under the original response identity.
The native page's stopped presentation therefore did not establish server-side completion.

The old extension treated the app's synthetic native Stop click as a human click and emitted
turn_end immediately. The shared timeline then changed the request notice into a claim that
ChatGPT had confirmed cancellation. Neither transition had that evidence.

The original initiator of the desktop Stop operation is not established by the historical logs.
A separate production-renderer regression reproduced an unintended route: a generic empty form
submission invoked Stop without identifying the Stop control as its submitter. This is a proven
application defect, not proof that either reported incident took that route.

The debugging conversation's two failed injections have a different boundary: both arrived after
its last local call and before its actual final answer. They had no subsequent eligible tool
response in which to deliver. The recorded final in that conversation was real; the missing
injection does not itself demonstrate a fabricated Stop.

## Changes

The recorder preserves exact request ownership through page-local stopped and interrupted ends.
A later call that started after the end can reopen the same response, including after recorder
restart when the existing durable request-turn index proves ownership before that end. A newer
question, different request, pre-end call recorded late, or canonical native final cannot be used
to reopen the old source. Finish-only calls do not reopen it.

The bridge and shared sidebar projection separate visible work from permission to operate a
browser page. Exact work uses the existing ten-minute Pro and three-minute other-model display
windows. A released finish hold is not completion. A stopped page observation retains an already
earned display window without granting input or reload. Real subsequent work renews that window;
an old result cannot renew it. A closed page can display new exactly owned work, while its durable
departure still prevents automatic browser actions and worker/browser revival.

The extension now stores Stop intent as its timestamp. Only a trusted native gesture or the
already-authorized app operation establishes that intent. App intent is recorded before the
synchronous native click. The click emits no terminal observation. The normal observer may report
a stopped native view after it becomes idle, while a canonical final keeps its stronger meaning.
The existing activity feed withdraws an obsolete page veto only for exact same-turn calls started
after the request, when the app independently reports that same active turn and no pending Stop.
Old or revised rows, foreign calls, finish calls and final responses cannot grant that exception.

The renderer requires the actual Stop/Cancel submitter for its empty-composer control branch.
Generic empty or repeated form submissions cannot stop the turn. Normal Stop button and keyboard
activation continue to name the originally captured session and turn. Stop admission now logs its
exact session, conversation, turn and command without claiming provider cancellation.

## Verification

The new cases were run against the prior behavior and failed at the intended boundaries before
the corrections. Focused checks cover stopped-response reopening, restart and late-final handling,
the extension's obsolete Stop veto, display versus browser authority, and empty form submission.

The complete project verification and production build were run in this checkout. Detailed run
receipts are kept in ignored task output, since they contain local runtime provenance. The
production renderer was also exercised in a separate Electron/Chromium process by
`scripts/verify-input-queue.cjs`: all 18 checks passed, including native empty/repeated form
submissions, the actual Stop control, keyboard activation, queue cancellation and recovery rows.
The keyboard probe includes Chromium's character event as well as key down/up; the initial probe
without the character event did not activate the button and was not accepted as a product pass.

No installed application, provider conversation, live outbox or session ledger was modified by
these fixtures. This work does not claim that the fix is installed or published, nor that a
reload has a general success rate beyond the observed cases.
