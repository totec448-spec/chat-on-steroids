# Unreadable session history — PR #399 adaptation

## Scope and credit

Adapted from Maxim (@Maximapple), upstream PR #399, reviewed at
`0041cb84aa2d86db3d9652d8ae4b35a2c6e8c614`.
Future commit attribution: `Co-authored-by: Maxim <5410641+Maximapple@users.noreply.github.com>`.
Shared session-store behavior only; no Internal Chromium host, browser delivery, silence
recovery, compaction policy or UI changes. Preserve the separate uncommitted #392 listener patch.

## Failure and repair

- Read failures previously became zero journal sequence, missing metadata or skipped catalog
  rows. The recorder could then create a second session for an existing conversation.
- Locked primary metadata must not fall back to an older backup: that backup may predate a
  conversation rebind. Missing/damaged primary bytes retain validated-backup recovery.
- A catalog pass now fails if a candidate cannot be read. Its existing single-flight retires
  normally; the next caller can retry. No partial index is published or remembered as a miss.
  Current and historical owner lookups also propagate indexed-owner read failures.
- Canonical history and journal recovery propagate I/O errors before publishing reconstructed
  metadata. Missing optional files and existing damaged-JSON handling remain supported.
- An append error can occur after bytes reached disk. If reading its outcome also fails, the
  live writer retains an explicit recovery requirement. The existing per-session queue restores
  the durable snapshot before any later event, canonical message, image, metadata mutation or
  unattributed rewrite proceeds. There is no independent retry loop or timer.

## Risk trade-off

A cold catalog cannot prove absence or uniqueness while even one candidate is unreadable.
Lookups/sidebar operations depending on that catalog can therefore fail temporarily instead
of silently omitting an owner. They recover on a subsequent call when filesystem access returns.
An already warm catalog is not rescanned for every event. Healthy writes add no filesystem work.
The rare uncertain-append branch deliberately blocks later writes until recovery succeeds.
This is integrity protection, not a filesystem repair or power-loss/fsync guarantee.

## Validation

Synthetic temporary histories only; installed/live user session ledgers were not modified.
New regressions first demonstrated metadata failures being accepted as missing ownership,
journal failures resetting projections, and an uncertain committed append allowing sequence reuse.
The focused failure/recovery cases now pass, including EACCES/EBUSY/EMFILE, stale backup
identity, cached and ambiguous owners, journal stat/open failures, both outcomes of an uncertain
append, canonical history failures, corrupt-primary backup recovery, and absent/stray entries.

- Mainstream: all 15 new focused regressions passed; typecheck passed.
- Mainstream full `npm run verify` passed with `VITEST_MAX_WORKERS=2`: privacy, notices,
  native source inventory, typecheck and Electron resolution; 6,180 tests passed / 46 skipped
  in the broad run, followed by 26 passing native/shutdown tests with one worker.
  Total: 6,206 passed. The broad run took 527.78 seconds; native/shutdown took 5.86 seconds.
- Internal: typecheck passed; session, continuation, resume, correlation and attribution-repair
  suites passed (318 tests). The full suite was not redundantly repeated in Internal.
- Both repositories: `git diff --check` passed; store, session tests, contributor credit and
  this worklog are byte-identical. The shared #392 files remain byte-identical too.
  AGENTS.md received the same scoped contract paragraph while preserving variant differences.
- At the source-validation checkpoint no build, installation, commit or push had been performed.

## Authorized installed acceptance

The subsequent user request authorized commits, an Internal build and remote acceptance on a
second Windows host. Source commits: Mainstream `7c53dfa`, Internal `6ef2fe9`, with both
upstream co-author trailers. No push was requested or performed.

- Internal `npm run dist:x64` and `smoke-packaged-runtime.mjs --platform win32 --arch x64`
  passed (Electron, Sharp/libvips, PTY, tree-sitter and packaged resources).
- Installer SHA-256: `52E53DAEDB0420DFD3E41145D955FE1BF66EEEA46D41284D667760D17ED82666`.
- Installed `app.asar` matched the built package:
  `78F3DCECAD78C5BAFF03243A107C9BCED21A731A03700779B94CA5142CCFBE48`.
- Both packaged and runtime-mirrored `extension/content.js` matched source:
  `2D57787B8ECE542B7BBFE4E29DA3A40EFCD9E9C12A51641E5DE6073D76756215`.
- A new isolated diagnostic conversation accepted a plain message and a synthetic red-square
  PNG through the normal desktop composer. Responses were correct; each send retained one
  confirmation check. Completion restored Send and the completed status rail.
- Reloading only that native ChatGPT document preserved the same two user messages, answers
  and checks, with unique event sequences and no visible context-frame leakage.
- Graceful app shutdown completed recorder/durable flush; cold restart recovered the same
  durable local session and exactly one current conversation owner. A follow-up completed
  normally with its third delivery receipt and no duplicate messages.
- One read-only PowerShell output command dispatched through MCP, completed successfully,
  and recorded exact request-id attribution under that same diagnostic session.
- Compact & Resume completed in approximately 48 seconds: source and destination native sends
  had exact receipts, the job reached `done` with no error, and the same local session retained
  old/new conversation lineage with exactly one current owner.
- Enter in the desktop composer sent a post-compaction diagnostic once and received the expected
  answer. All five authored diagnostic inputs retained their confirmation checks; the final
  timeline had unique event sequences, no visible context frame, no active turn or pending Stop,
  and the completed status rail. The two additional recorded user messages were the expected
  handoff request and replacement-chat bootstrap, not duplicate authored inputs.
- A second graceful shutdown and normal launch preserved the committed replacement conversation,
  both lineage entries and the completed durable state. The app was left running without remote
  debugging; port 9223 was closed. The test SSH forward and the two newly created scheduled tasks
  were removed. Existing user chats and pre-existing diagnostic tasks were left intact.

The log also contained renderer `ResizeObserver loop completed with undelivered notifications`
errors around composer updates. The tested sends completed despite them; their cause was not
investigated or attributed to this backend patch, and no UI changes were made.
Disk locks/failures remain synthetic-fixture evidence, not faults injected into live user history.
The live test does not establish every provider rollout, old-shell compatibility or power-loss safety.
