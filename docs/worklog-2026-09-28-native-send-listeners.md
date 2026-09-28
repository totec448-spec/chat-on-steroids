# Native send listener ownership

## Scope and provenance

Base: upstream main `797bea64f0c0304f65632faa73334ea477b5c45b`.
Adapt only the native send-listener lifetime correction proposed by @Gokuencinar in
[#392](https://github.com/totec448-spec/chat-on-steroids/pull/392), previously exercised
in the fork. Do not import that PR's other changes or the fork's cumulative commits.
Commit attribution: `Co-authored-by: Gokuencinar <Gokuencinar@users.noreply.github.com>`.

## Failure and repair

The recorder already owns listener disposal through `listen()` and `stopCleanups`.
The three native Send handlers bypassed it with anonymous `addEventListener` calls.
Stopping the recorder therefore left click, submit and Enter capture active, even
after a successor took ownership of the same document.

Register these handlers through the existing owner and reject `rememberUserSend()`
after retirement. No new lifecycle, timer, selector, Send policy or storage is added.
This proves stale capture, not duplicate provider submission or a general prompt-leak fix.
Already-loaded old anonymous handlers require a page reload to be removed.

## Validation

- The three new production-script regressions failed on the original source at the
  retired-recorder assertion (one unexpected attachment read per send event).
- All three pass with the correction. They cover healthy-incumbent reinjection,
  retirement, successor ownership, repeated old-owner stop, draft preservation,
  unrelated controls, Shift+Enter and IME composition.
- Typecheck passed.
- `npm test -- test/content-script.test.ts test/chatgpt-dom-input.test.ts --maxWorkers=1`:
  857 tests passed across both complete files (66 seconds, one worker).
- `git diff --check` passed.
- `npm run verify:privacy` passed. A final fetch confirmed the base still matches upstream main.
- The earlier read-only DOM probe reproduced the same ownership defect on both main
  and PR #547's head; the in-memory correction fixed both. This change does not alter
  #547's send-model association or message re-emission paths.
- No signed-in provider test, installer or local full verify has been performed for
  this branch. Fork validation is not new-base live acceptance; cross-platform CI
  results must be reported separately from these focused local checks.
