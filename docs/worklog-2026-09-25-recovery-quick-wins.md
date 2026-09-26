# Recovery quick wins — 2026-09-25

## Scope and sequence

Small, independently validated changes in both repositories; no changes to the
Internal Chromium host, partitions, browser liveness policy or Browser Use.

1. Adapt #397: allow an automatically withdrawn, provably unsent recovery ticket
   to be filed again under fresh owner/source proof.
2. Adapt #405: localized native Stop recognition, preserving Send/voice,
   visibility, ambiguity and exact-turn guards.
3. Adapt #401's diagnosis: escaped historical private frames without changing
   literal authored suffixes or manufacturing receipts.

Storage/catalog integrity, worker lifecycle and broad runtime proposals remain
separate work; these are not silently included in this small block.

## Implemented: unfinished-response recovery

The deduplication gate in session/input.ts previously treated an automatically
withdrawn rescue as a permanent veto for its recovery episode. Fresh local work
can withdraw an unsent rescue without answering the turn.

Only that automatically cancelled case is released. Manual cancellation and
failed/live rows retain their existing episode veto. Send authorization or a
delivery/message receipt remains spent across episodes. The existing serialized
outbox, current-owner/source checks and authored-queue precedence are unchanged.
No new retry timer, watcher, state field or browser-opening authority was added.

Adapted from Maxim (@Maximapple), upstream PR #397, with narrower admission than
the proposed general terminal-row allowance. Future integration must retain
Co-authored-by: Maxim <5410641+Maximapple@users.noreply.github.com>.

## Actual validation

- Before the fix, the two automatic-withdrawal regressions failed; four retained-
  authority/manual-cancellation cases passed.
- Mainstream: input-delivery-integration and session-input suites: 472 passed.
- Internal: nine focused regressions passed, 273 unrelated cases filtered out.
- Typecheck passed in both repositories.
- Cases cover concurrent refiling, durable outbox reload, old-claim rejection,
  retained claim/authorization, manual cancellation, changed conversation,
  lost owner and authored input waiting in the queue.
- Full verify was started, then intentionally interrupted at the user's request.
  Its process tree was stopped and absence of running Vitest was confirmed.
  This is not a full-verify pass or a test failure.

No new installer, installation, live recovery confirmation, commit or push is
claimed by this entry. Full verification is deferred until the implementation
block is finished and only if needed, as requested.

## Implemented: localized native Stop

On a signed-in current shell, the primary slot was observed as a four-path Voice
button while idle, an arrow on Send and an exact single square path on Stop.
Stop had no test id. The adapter still prefers the established ids/labels; only
when those are absent does it check the current form's non-submit primary button
against that exact square. This is narrower than #405's path-prefix match.
No label translations, new turn authority, polling or host changes were added.

Two positive/ambiguity regressions failed before the fix; eight negative cases
already passed. The shell-compat and chatgpt-dom-input suites then passed all
205 cases. Cases include Send, voice, unknown icons, hidden/inert controls,
history, another form, missing slot classes, duplicate candidates, explicit
selector priority, disabled buttons and owner invalidation before the click.

Live validation loaded the current adapter into a separate diagnostic isolated
world; it did not replace installed extension files. A native Stop was briefly
given a translated label, restored immediately after the check: the baseline
reader missed it, the new reader found the exact same native button, and the
guarded click succeeded. A later observation showed no Stop and no generation.
The account remained in English, so this proves controlled translated-label
handling on the real DOM, not a test of every account locale.

The initial live diagnostic hit two ordinary readiness boundaries: Send had
not mounted immediately after insertion, and Stop had not mounted immediately
after accepted submission. Observing again avoided duplicate sends. A bounded
test-only wait for Stop made the final check deterministic; no such wait was
added to production. One diagnostic answer completed before inspection.

The whole-message unescape proposal in #401 is not incorporated; the subsequent
prefix-only adaptation is documented below.

Final focused checks for this Stop increment: Mainstream content-script,
shell-compat and chatgpt-dom-input: 961 passed; Internal shell-compat and
chatgpt-dom-input: 205 passed. Typecheck and diff whitespace checks passed in
both repositories. Changed production files, shell regressions, contribution
credit and this log are byte-identical. Input-delivery tests retain only the
pre-existing Internal host mock difference; the new test patch is the same.
The two AGENTS maps preserve their repository-specific host contracts.

## Implemented: escaped historical private frames

The existing content reader handled escaped context contents, but not escaped
opening/closing markers. It now matches delimiters with their original offsets,
normalizes only the private prefix and retains the provider's authored suffix.
The exact shared/DOM frame parser and Send receipt comparisons are unchanged.
Concealment hints inspect only the first 400 characters after leading whitespace,
including escaped continuation/header markers and flattened title line breaks.
Malformed frames remain concealed and unpublished rather than guessed.

The existing 32-boundary search limit is retained, including overlapping quoted
boundaries. Delimiters select the hard-break decoding mode before length checks.
A live diagnostic with deliberately damaged synthetic context exposed the old
two-candidate decoder's length-compensation ambiguity: a retained line-break
escape could replace a missing character. A failing integration regression
reproduced it; one delimiter-selected decoder now rejects that damaged source.

Five marker/concealment checks failed before the change. Focused tests cover
classic and current-shell history without a Send cache, HANDOFF/RESUME markers,
empty context, Unicode, literal path/glob/backslash text, encoded suffixes,
nested/overlapping boundaries, malformed length, the search bound and ordinary
non-frame text. Historical reads emit neither a fabricated ACK nor a new turn.

On the signed-in page, a new synthetic test message preserved its exact native
frame and authored backslashes. After reloading that diagnostic conversation,
the current reader was evaluated in a separate diagnostic world: native source
stayed unchanged; a controlled escaped-prefix variant preserved the identical
suffix; a controlled damaged variant was rejected and concealed. The account
did not spontaneously produce the fully escaped header, so that variant is
controlled evidence, not a claim of a natural provider reproduction. No private
session exports, account data or diagnostics scripts were added to either repo.

This change adapts Maxim (@Maximapple)'s #401 diagnosis, not its whole-message
decoder. No Internal host, bridge protocol, timer, stored identity or recording
authority was added. New package/install validation remains pending.

Final checks after the deterministic decoder fix: Mainstream content-script,
shell-compat, chatgpt-dom-input, user-prompt and session-prompt suites: 990 passed.
Internal targeted frame/receipt regressions: 24 passed (other tests filtered).
Typecheck and diff whitespace checks passed in both repositories. These are
focused checks, not full verify; no new installer, commit or push was made.


## Packaged and installed acceptance

Built the Internal Windows x64 installer from the current working tree without
starting another full verify. Packaging and the packaged-runtime smoke passed,
including Electron, Sharp, node-pty and tree-sitter. The packaged main bundle
matches the generated bundle; the packaged extension matches current source.
The installer is unsigned (no publisher certificate configured).

Installer SHA-256:
`C68FDFBF1F81495305D9D60E2F985B0A741B34847B30BB9D5F66D7A35D004397`.
Packaged/installed app.asar SHA-256:
`15C103D559D4BE51B451ADDE67842A93FE70D9F28DA9F5634BAE79026B4B58CC`.

On the authorized remote Windows notebook, the app had shut down normally
before installation. The transferred installer hash matched; installation
returned zero. Installed app.asar, packaged extension and the running profile's
extension mirror matched this build. No profile or history ledger was edited.

Acceptance used the installed implementation, not injected replacement code:
- A fresh message sent through the CoS composer received a native message id
  and a visible confirmed check. Its turn completed normally.
- A second, bounded diagnostic generation was stopped through the CoS composer.
  Its native Stop label was temporarily translated for this check; the installed
  adapter still recognized it, native generation stopped, and the recorder
  reported a stopped turn. The diagnostic label override was cleaned up.
- After reloading only this idle diagnostic conversation, both authored messages
  and confirmed checks remained, without duplicates or visible private context.
  Recorded event count remained eight; no turn was resurrected, Stop was not
  pending, and the composer returned to Send.

This demonstrates installed delivery, ordinary completion, translated Stop and
native-history rereading. It does not claim a natural escaped-header reproduction,
a live induced automatic-recovery failure, or a full verify pass. Temporary
diagnostic scripts stayed outside both repositories. No commit or push was made.
