# Model discovery and native picker robustness (#311)

## Scope and evidence

This change addresses reproducible discovery waits and model-identity failures related to
[#311](https://github.com/totec448-spec/chat-on-steroids/issues/311). It does not claim that
the reporter's alternate editor, picker metadata or missing transcript has been fully diagnosed.

The previous implementation required an idle recognized composer, but any existing ChatGPT
tab also prevented creation of the already-authorized discovery helper. An explicit Refresh
therefore stalled when the only existing tab was generating. Previously observed models hid
the impact on established installations; first-time installations had no usable catalog.

Two additional concrete failures were reproduced during review: the background worker dropped
the elected observation route after 35 seconds while the app still allowed a 120-second scan,
and a previous MAIN helper could win a picker reply after an extension update because its
listener was removed only when its Fiber protocol version matched the replacement.

@redzrush101's screenshot in #311 identified `data-codex-intelligence-trigger`,
`data-composer-navigation-target="reasoning"` and `data-selected-reasoning-effort`.
Tests cover these anchors with supported native model-owner metadata. The actual alternate
editor and opened menu were not supplied. Neither those tests nor a successful test on the
maintainer's different account establishes complete compatibility with the affected account.
@ehkogh also reported the problem and offered a fix; no unpublished contributor code is
included or represented as incorporated by this change.

## Changes

- Explicit Refresh may open one owned, background discovery helper when every existing user
  page positively reports generation, a protected draft/attachment, another input operation,
  or a hidden composer. Missing recorder replies, hydration, an existing helper or an already
  spent election do not grant another opening. Passive discovery never uses this permission.
- The existing nonce and persisted election own the operation. First explicit promotion of a
  passive request renews its budget once; repeated explicit clicks cannot extend it. The
  elected result route remains valid through the app deadline, including scans over 35 seconds.
  Helper load completion wakes existing maintenance instead of adding another poller.
- Strict machine progress reasons describe the wait without publishing model evidence. Failed
  refresh remains visible alongside cached success and retains the last concrete problem at
  timeout. App-authored notices have Spanish and both Chinese translations.
- Discovery does not clear text, including a draft restored on its helper. Running responses,
  drafts, attachments, exact document/epoch checks and normal picker restoration remain guarded.
- MAIN identifies the native model owner among composer menus. The reported alternate anchors
  require that proof; an effort attribute alone cannot create a catalog or select a model.
  Machine effort values do not depend on translated captions. Unknown values remain unknown.
- Model-name matching retains Unicode letters/numbers, rejects empty or ambiguous names, and
  prefers exact provider identity over matching labels in another native version. Effort-only
  captions are not model aliases. Spaced/localized version ids stay navigation metadata;
  catalog execution ids use actual provider slugs when the group is not a valid execution id.
- Saved worker/helper execution aliases and their effort remain exact until a deliberate
  family selection. A family's effort union cannot justify silently rewriting a lane alias.
- Recorder/Fiber generations advance to 14. MAIN replacement retires its previous listener
  across versions, including the shared v1 picker/plugin channels. Corresponding fixtures agree.

## Validation

The new regressions for the 35-second routing cutoff, helper draft clearing and stale MAIN
listener each failed before their fixes, then passed in the complete suite.

`npm run verify` passed in a focused worktree based on public main: 5,434 tests passed and
45 skipped in the main run, followed by six passing isolated shutdown tests. Total: **5,440
passed, 45 skipped**. TypeScript, public-history privacy, 153 production-package and seven
catalog-entry notices, and 730 native-source inventory checks passed.

`npm run build` passed for main, preload and renderer. Vite emitted informational mixed
static/dynamic import warnings; no build error occurred.

A signed-in native ChatGPT home page exercised the changed production picker functions through
an isolated, hash-verified extraction, without replacing the installed recorder. It discovered
three model families, restored the original selection after discovery, selected the exact
observed High execution model, rejected an unobserved model and restored the original 6 Pro
selection. The operation completed in 1,576 ms, with an empty composer, closed picker and no
interruption or inspection failure. No chat was sent. The empty test-created tab was then closed.

This is live adapter evidence, not installed end-to-end app acceptance. The installed app and
companion were not replaced or restarted. No account data, raw page/network dumps, local paths
or conversation content are part of the PR. The missing-message symptom remains open pending
an affected-page capture or a contributor branch that reproduces it.
