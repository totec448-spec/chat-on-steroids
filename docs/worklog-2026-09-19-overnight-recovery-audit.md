# Overnight Continue recovery audit

## Confirmed defects

A replacement browser document can observe a previously recorded user message with
different Markdown or expanded text. The recorder already distinguishes a newly
authored question from a historical observation. That verdict was not passed to
the canonical user-message update. The text revision therefore advanced the work
sequence even though the bridge correctly classified it as history.

Automatic Continue captures the current question and work sequence before it is
offered to the browser. In the reproduced failure, the inconsistent historical
increment made its outbox owner reject the ticket as changed activity. Cancellation
happened before browser claim, so the ticket could never reach its conditional
Stop or Send steps. The existing generic cancellation text did not identify the
failed guard. Read-only extraction of the installed application bundle confirmed
both this old work-sequence formula and the exact cancellation branch; this was
not merely a discrepancy in an unused source checkout.

The recorder now passes its authorship verdict to the store. Re-observing the
same known user identity updates the canonical text and history cursor while
preserving its work sequence. A newly authored revision, a different question,
new tool activity, a final answer, manual Stop, Block and changed ownership still
withdraw recovery. Historical updates from superseded conversations use the same
rule.

Cancelled Continue cards were also omitted from the renderer's existing historical
automatic-input path. The supplied screenshot shows all three cancelled records
below the newest transcript. The outbox records were created in different source
conversations about an hour apart; their first visible paint and cancellation times
were not retained. The user's recollection of cards appearing one, then two, then
three cannot be ruled out from those creation timestamps. They now use their creation times
and the existing timestamped history placement. Pending Continue controls and
explicit cancellation remain unchanged.

The outbox now retains a specific cancellation reason and logs that committed
transition once. This makes a blocked chat, new question, new work, completed
answer, disabled continuation or changed source distinguishable in future audits.

## Recorded behavior and limits

The inspected run crossed four provider conversations with three committed
handoffs. Six ordinary Goal follow-ups reached native user-message history and
started subsequent turns. Three separate automatic Continue attempts were
cancelled without a browser claim or Send authorization; they were not three
delivered messages. The final two acknowledged reloads were three minutes apart.
The user then blocked the chat and the app shut down. The retained logs do not
show a thirty-second reload loop.

Historical user revisions and advanced work stamps are present in the retained
canonical data. The new regression reproduces the resulting pre-claim cancellation.
The old generic error and lack of a cancellation timestamp do not establish which
guard cancelled each historical ticket, nor whether the last cancellation preceded
the user's Block. The initial provider-side transport failure has no retained
network trace. These limits must remain separate from the reproducible code defect.

The screenshot's exact old error text comes from `expireQueued` in the input owner.
It can run when the app lists the outbox as well as before a browser claim. A new
ticket can consequently appear with an error immediately: a historical observation
changes the stored work stamp after admission, then the next outbox read cancels
it before any browser accepts it. The preserved rows have `owner: null`, phase
`ready`, and no offer, authorization or native receipt. This identifies local
pre-delivery cancellation, not a browser Send followed by a lost acknowledgement.

Earlier in the run a native turn was reported failed while attributed local calls
continued. Another resumed turn's start was recorded about twenty minutes after
its first attributed calls. Neither period was a proven work pause. Worker updates
were rejected during owner handoffs, then their substantive findings appeared in
delivered finish reports. No final worker report was found permanently missing.
The original rejected sends remain rejected; later reports are separate receipts.

## Verification

The four initial regressions failed on the old implementation: three Off/Goal/Loop
recovery cases and the cancelled-card timeline case. They passed after the fix.
The recovery test now covers normal and Pro models in each of Off, Goal and Loop.
It re-observes the same question with changed text, including an explicitly false
and an omitted authorship flag, and preserves its ticket and deadline. Send is
denied between the Stop claim and the confirmed stopped phase. A duplicate native
receipt does not authorize another Send. A new turn with confirmed local work earns
its own later recovery window, two minutes plus one minute normally and ten plus
five for Pro. It never reuses the previous ticket. Existing tests cover one-use
Stop/Send authorization, the shared 2/5/10/15-minute pickup schedule and native-page
changes at the action boundary.

Six adjacent suites passed with 798 tests. The expanded subsequent-episode checks
passed in all three automation modes. The isolated Electron/Chromium fixture passed
15 checks, including chronological cancelled cards at 1100- and 640-pixel widths;
its screenshots were inspected. It uses isolated user data and no live provider.

The final shared-tree `npm run verify` completed with exit 0: **5,347 passed and 45 skipped**
in the main run, then **6 passed** in the required separate shutdown run. Total:
**5,353 passed**. Privacy, dependency notices, pinned native-source metadata and
TypeScript checks also passed. The earlier focused tests overlap this coverage.
The isolated Electron fixture was rerun successfully with all 15 checks.

The shared-tree gate exposed two integration issues outside the Continue change.
The updated Windows observation description exceeded its existing discovery size
budget; it was shortened without removing the new text-only/capture-error contract
or raising the budget. The new browser inspection test inferred a UUID-only mock
return type for opaque document IDs; its fixture now returns a plain string. The
parallel keyboard-hint tests were already reconciled by their owner. A separate
unchanged PowerShell test timed out in an earlier full pass, then passed in isolation
and the final full pass without any timeout or assertion change.

`npm run build` completed with exit 0 and produced the main, preload and renderer
bundles. Vite retained three mixed static/dynamic import warnings for input,
input attachments and skill metadata. These were warnings, not build failures.

An earlier full pass had already passed 5,340 tests including shutdown. Additional
interim-ordering regressions then arrived from another active chat and initially
failed while their implementation was pending. Its subsequent chronology/store
change passed a joint 20-case check with the Continue regressions. Full verification
and the build were then repeated for that combined state, producing the final
counts above. All 539 tracked runtime, extension, test and script files in the
verification snapshot were unchanged throughout that final full pass. These
parallel changes were preserved and are not claimed as this audit's work.

The original affected provider account was unavailable. The installed browser
connector also refused attachment to active executor tabs. The completed browser
evidence here is therefore the isolated Electron fixture and the recorded native
observations, not a live replay of the original account after installation.

No live app restart, installation, commit or publication was performed by this audit.
Private session identifiers, prompts and raw evidence remain in the ignored local
audit directory. `recheck.json` records the timestamp and installed-bundle review;
`verified-joint.log`, `build-joint.log` and `ui-final/result.json` retain the final
checks. `joint-before-state.json` and `joint-after-state.json` identify the same
tested source snapshot.
