# Alternate shell follow-up delivery, issue #311

The reporter's retest after #319 confirmed model selection but still reported blocked follow-up
sends, worker startup and visible setup instructions. This follow-up compares the two privately
provided page captures with @ehkogh's #318 and the matching public client modules. Private exports,
account/session fields, network payloads and real conversation text are not publication inputs.

## Demonstrated boundaries

The shell editor serializes ordinary inserted text as Markdown. The native literalPaste mark,
identified in #318 and confirmed in the matching client schema, preserves prepared punctuation and
hard breaks. The adapter applies that mark only to the marked shell editor, through its existing
single HTML edit. Classic insertion and the exact native Send receipt remain unchanged.

The shell user bubble lacks the classic role attribute. Its current MAIN message stamp now joins
the bubble to the same exact source/frame parser used by the recorder. Presentation hides only a
valid setup frame, and restores original presentation when a reused bubble no longer has one.

An older exchange may retain in_progress after a later exchange finishes. Only the latest native
exchange can provide the composer's typed running hint. This does not synthesize a completed turn
or a tool receipt. The normal exact final and native control guards remain in force.

The shell's typed tool invocation can use the underscore recipient spelling of the known connector
name. Both exact spellings are accepted; similarly named third-party connectors remain excluded.

Typed items omit backend request metadata. The bounded native cache observation from #318 is
adapted to read only request ids/timestamps for the mounted exchange's explicitly named message
ids in its exact conversation cache. The query, node and message identities must agree. Multiple
matching caches, conflicting conversation ids and duplicated selected ids abstain. Cache failure
does not erase typed messages. No child traversal, cached answer text or cached final status is
used; the existing stream observer still supplies early live request evidence.

Recorder, MAIN helper and background restoration versions advance together to 16 so an older
live recorder cannot prevent the new adapter from loading. The app/extension release stays 2.1.14.

## Verification

Before changes, the focused regressions reproduced both text/presentation failures and the three
additional metadata/name/busy gaps. Synthetic integration fixtures exercise the production DOM
adapter, MAIN helper, isolated recorder, native model-selection path, exact Send acceptance and
extension-to-app publication contract. They cover three successive desktop inputs and worker
bootstrap, including multiline instructions, answer completion, prompt presentation and attribution.
Classic input/recorder/extension suites run alongside them.

Full repository verification passed: 5,509 tests plus six isolated shutdown tests, with 45 skipped.
TypeScript, public-history privacy, dependency notices and pinned native-source checks passed.
The Windows x64 production build and installer completed successfully. A separate isolated
Chromium 153 check used native HTML editing and native button clicks: it retained the literal
mark and exact text, traversed/restored the picker, selected the exact worker lane, and completed
three successive sends with one exact receipt and a settled final for each. Page data in that
check was synthetic; it did not load the private captures or contact the reporter's account.
CI and installed-payload acceptance remain separate publication gates.
The reporter's actual NixOS/affected-account execution cannot be established by these fixtures.
The issue remains open for that retest; source/test proof is not claimed as their live acceptance.
