# Managed pruning is not a manual departure — 2026-09-26

## Evidence and decision

Adapted Maximapple's #446 at 1f461e6d03c2d5ea23fe056d0ccc6805f51d8807:
https://github.com/totec448-spec/chat-on-steroids/pull/446

Co-authored-by: Maxim <5410641+Maximapple@users.noreply.github.com>

The shared extension previously sent manual:true for every final-tab departure,
including successful pruneManagedTabs cleanup. Main intentionally persists manual
dismissal and refuses automatic recovery until that page returns. This is a real
source-level mismatch in both variants; it is not proof that it caused the earlier
private real-run departure. No live user session was changed during this slice.

The upstream in-memory Set does not survive MV3 suspension, records attempts rather
than successful API outcomes, and does not resolve a later manual departure while
an automatic close remains pending. The adaptation corrects origin at its owner
instead of weakening main's manual-close/recovery fence.

## Narrow implementation

- Only managed idle/retired/duplicate pruning produces an automatic-removal receipt.
  Other removals/navigation keep their previous conservative classification.
- The existing tab queue serializes the final tab-state/document/journal checks,
  removal result, and lifecycle processing. Content-script close-check messaging
  stays outside that queue to avoid a callback/registration deadlock.
- A successful removal stores tab + document + navigation epoch + conversation
  in the existing session-storage snapshot, bounded to 1,000 receipts. A rejected
  attempt stores no automatic-origin proof. Restore and event handling require the
  matching original owner; replaced documents/epochs cannot inherit it.
- The receipt is consumed into the existing bounded close outbox and removed after
  lifecycle handling. Offline retry and worker restart retain the departure origin.
- A later manual close replaces a pending automatic entry. Replacement by identity
  means an older in-flight response cannot remove the newer manual decision.
- Mainstream still calls Chrome tabs APIs. Internal still uses browserTabs and its
  existing awaited host lifecycle; no native host, bridge, protocol, browser
  rendering, recovery timer or opening-eligibility implementation changed.

## Regression evidence

Four public-handler cases failed before the production change and passed after:
ordinary automatic removal, MV3 restart, early removal event, and offline close retry.
A fifth regression exposed pending automatic-close precedence after a manual reopen
and close; it passed after replacing that outbox entry.

Final cases also cover failed removal, replaced document, changed navigation epoch,
and removing a duplicate before the user closes the remaining copy. Existing
pin/draft/selected/recent-page/journal and cancellation guards remain exercised.
A separate production-outbox test proves an old automatic response cannot erase
the later manual entry.

An initial attempt to replay the Chrome in-flight callback scenario through the
Internal fixture timed out: that host awaits its event batch before allowing a new
page bind, while the fixture was waiting for that bind before releasing the batch.
The cyclic test was removed from both variants and replaced by the shared outbox
race test plus each variant's actual lifecycle tests. No production timeout or
assertion was weakened to make it pass.

Bridge tests explicitly distinguish omitted/false/true manual flags. Active owned
work retains eligible recovery only without manual dismissal; completed/personal
chats stay closed and user close revokes a handed repair.

## Risks and limits

The original pruning eligibility is intentionally unchanged. A crash after browser
removal but before its successful receipt is saved can still lose origin proof;
the fallback is conservative manual classification, not guessed reopening.
Browser shutdown and malformed/legacy records likewise do not acquire automatic
authority. The small receipt records are not a new recovery scheduler.

This does not fix legitimate long-thinking misclassification or adopt #420. It
does not make every programmatic tab closure non-manual. The actual provider/account
cleanup classification was subsequently exercised in the installed build below.
No commit, push or full verify was performed in this slice.

## Final checks

- Complete extension suite: 258/258 passed in each repository on the final code.
- Focused bridge recovery/departure cases: 9/9 passed in each repository.
- Internal native-host and extension-path suites: 14/14 passed.
- Both typechecks passed; diff whitespace checks passed.
- Production deltas match after normalizing only the preexisting Chrome/browserTabs
  API spelling and event-handler indentation. Native host files remain untouched.
- No test process remains. Installed acceptance is recorded below; the older
  worker-ack installer does not contain this change.

## Package preparation

Internal Windows x64 packaging produced a new installer; packaged-runtime smoke
passed for resources and native dependencies. Packaged background.js matches the
reviewed Internal source. The production main bundle is unchanged, as expected.

- Installer: Chat-On-Steroids-Internal-20260926-managed-close-x64.exe
- Size: 173390604 bytes
- SHA-256: 80BB0A7F0F5F56533118786CA3BC8B18FBBA6E5387D182BC385D8DFEB201B6AE
- app.asar: 0F41D0F35B0D61940C1E2F1FCE8705A87B1D5287A67B5DFE025B24C79C4963B3
- background.js: E6CB58BD5D39454412F1DBD8204191A5C5E04D2B283F5274A55EDA5723A23C44

The installer was copied to both notebooks' Downloads; the remote SHA-256 matches.
After the user quit normally, installation completed with result 0. Installed
app.asar, packaged extension and the active userData extension match the hashes above.
No commit or push of this slice.

## Installed acceptance

A new diagnostic conversation sent one minimal text request without tools, files
or images. Its exact native receipt was recorded; the response completed, the
delivery check persisted, Worked settled and the composer returned to Send.
No project conversation was sent to or closed.

The completed diagnostic was left unselected and unpinned, with an empty composer.
No policy, timestamp, ledger or timer was edited. A neutral ChatGPT home tab was
created through the existing authenticated browser-host create operation solely
to leave the diagnostic unselected.

- After the ordinary idle threshold, the diagnostic was eligible for closure.
  It did not close on elapsed time alone during the observation window.
- Reloading only the neutral page produced a normal maintenance pass. Its observed
  policy named the diagnostic managed, unprotected and closable. The app removed
  that tab and recorded its departure while browserRecoveryDismissedAt remained
  absent. The closed completed chat stayed closed; recovery was disabled.
- Explicitly reopening the same diagnostic preserved its contents. Closing it
  through the panel's fixed close API set browserRecoveryDismissedAt and logged
  deliberate closure. There was no unsolicited reopen.
- The removal receipt and close outbox were drained after automatic departure.

This validates automatic-versus-manual origin on the real installed host, not
unattended cleanup cadence or active-work recovery. The missing time-only cleanup
is a separate observation requiring investigation; its cause is not established
and no new polling/timer was added to conceal it. MV3 restart and adversarial
ordering remain automated-test evidence, not live-test claims.

Existing ResizeObserver warnings recurred without attribution to this extension
change. An initial diagnostic probe could not access module-local bindings; a
second probe lacked protocol headers and was rejected. Neither dispatched input;
the corrected probe used the existing authenticated, versioned host boundary.

The app quit normally after acceptance and was relaunched without diagnostics.
Verified zero debug-flag processes and no listener on 9223. Test scheduled tasks
and the local SSH diagnostic forward were removed. No production source changed
after packaging; this acceptance only updates documentation.

Final review reconfirmed equivalent production deltas in both variants, preserving
their different tab APIs and lifecycle handlers. Public-history privacy and diff
checks passed in both repositories. Source/installer hashes still match the
accepted package. No test or diagnostic-forward process remains. No additional
production fix was needed; commit/push and unattended-cadence investigation remain
separate next steps.
