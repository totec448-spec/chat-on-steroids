# Open PR bug-fix review — 2026-09-16

## Scope and method

Screened all 39 open PRs against public main `efc69f35` and the shared local tree. The user prioritized real bug fixes, required checking the code against current implementation, and authorized closing already-fixed PRs. Feature/UI proposals were screened for scope, not represented as fully audited implementations. Bug-fix candidates received implementation/contract comparison; the two accepted patches received before/after reproduction and combined verification.

Fetched exact PR heads and diffs into isolated review worktrees. Never checked out, reset, cleaned, committed or published the shared dirty tree. Before local application, backed up the six affected source/test/document files outside the repository. Only the two reviewed patches and this review/credit documentation were added locally. No package, installation, version bump, tag or release was made.

## Accepted

- **#268**, head `e420bc82a75c55e40a81aa4fb505054b4cf56af2`, merged as `31589c1d15569886751a07203139562b9bae506b`: npm plugin installation now passes the exact generation directory through `--prefix`. The current installer previously relied on cwd, allowing npm to choose an ancestor project while subsequent manifest reads still expected generation-local files. Reproduced with a real offline local tarball: before, the package existed only under the parent; after, it existed under the generation. This retains script suppression and argument-array invocation on Windows.
- **#265**, head `09f18496865ddd05bd8195f84bc79e5a813aad91`, merged as `4e30b62e0adbccaf5741a34bfb67ca8f44df61ab`: manual continuation expiry uses one hour during `awaiting-summary` only for the frozen, confirmed Pro selection. Restore uses the corresponding retention window. Ordinary/unobserved selections and captured/claimed phases retain ten minutes. Checked the bridge destination deadline separately: it governs the later claimed phase and does not cancel the writing window. New Pro expiry/restart tests fail against unmodified main and pass with the patch.

The four changed implementation/test files are identical between merged public main and the local tree after application. Original authorship is retained in the GitHub squash commits, merge messages and CONTRIBUTORS.md.

## Every PR decision

| PR | Decision | Current-code reason |
| --- | --- | --- |
| #268 | Merged | Reproduced npm generation escape; narrow owner-level fix. |
| #267 | Hold | Deferred revival reloads every discarded exact-conversation tab, rather than one elected document, without fresh navigation revalidation around the reload await. A second stalled-recovery path also adds policy surface. No live Chrome proof was supplied. |
| #265 | Merged | Reproduced premature manual Pro expiry and restart loss; preserves later phase deadlines. |
| #264 | Leave open | New connection/diagnostics UI and transport, outside the bug-fix selection. |
| #263 | Hold | `announceSessionFinish` returns before normal finish handling whenever any plan step is incomplete, including the expected final verification step. It also pauses a plan on any completed turn without checking `activatedByTurnId`. This conflicts with the existing near-finish contract and exact-turn ownership. |
| #260 | Leave open | New Skills feature, not a focused bug fix; local removed artifact-tool surface also differs. |
| #255 | Leave open | New embedded browsing subsystem, overlapping current extension browser control. |
| #254 | Leave open | Composer slash-mode feature/UI work. |
| #252 | Leave open | Sidebar organization/UI change. |
| #251 | Hold | Combines model-discovery custody changes, startup policy, and tunnel suppression. The suppression fallback checks whether serialized event data contains `harpoon`, not whether its actual channel is Harpoon. MV3 coverage seeds stored custody rather than exercising the production handoff through suspension. Not accepted wholesale. |
| #249 | Leave open | Sidebar redesign. |
| #247 | Leave open | macOS sidebar/titlebar redesign; fullscreen correction is already incorporated separately. |
| #246 | Leave open | Audit report/reproductions, not an executable fix. |
| #245 | Closed: incorporated | Public main already uses `fullscreenable: process.platform === 'darwin'`, with regression and contributor credit. |
| #243 | Leave open | Traditional Chinese localization feature. |
| #242 | Leave open | Large Files workspace/editor feature and dependencies. |
| #240 | Leave open | Spanish localization feature. |
| #237 | Leave open | Embedded ChatGPT architecture change with merge conflicts. |
| #234 | Closed: adapted | Current recovered-error presentation already has title/color changes and uses existing chronology/completion-versus-later-work evidence. Do not restore the proposal's separate reconciliation scan. |
| #232 | Closed: adapted | Current macOS sealing removes the unused keys and verifies full parsed plist readback; this is stricter than treating arbitrary extraction failures as absence. |
| #231 | Closed: superseded | Earlier maintainer snapshot. Current source retains stream ownership, bounded late finish identity, Goal debt preservation, resume claim-window handling and refusal fixes, with later changes layered on top. |
| #229 | Hold | Makes stopped/sleeping worker tabs immediately closable using zero grace, conflicting with current two-minute reuse/five-minute idle-close policy and separate terminal grace. |
| #227 | Closed: adapted | Current access-limit handling preserves the exact existing Goal grant and deadline, with additional current-session checks and regression coverage. |
| #224 | Leave open: partial | Recorder claim-window fix is already adapted. Proposed three-click Project navigation retries are intentionally absent and conflict with the one-click contract. |
| #221 | Leave open | New read-only health projection without fixing a current execution path. |
| #220 | Leave open: partial | Late finish identity/shared deadline and provisional Goal restore are incorporated. Additional response-branch/inbox changes are not established as fully incorporated. |
| #216 | Closed: adapted | Current publication supports 256 upstream tools; observation/enrollment additionally allows the registrar's optional code-mode tool. Reapplying the original narrower patch would lose that improvement. |
| #201 | Closed: incorporated | Test patch reverse-applies to public main; no missing production fix. |
| #195 | Closed: superseded | Earlier maintainer recovery/dependency snapshot is superseded by current runtime pins and later ownership/receipt work. No reason to replay its large old snapshot. |
| #192 | Closed: adapted | README/hero already remove the unconditional Codex-quota claim, with existing contributor attribution. This review did not independently re-research account billing policy. |
| #166 | Leave open | New external controller API. |
| #160 | Hold | Proposed retry counter increments per recoverable error observation, not per acknowledged failed reload. Duplicate observations can exhaust it without three reload attempts; do not add that second recovery ledger. |
| #157 | Hold | Defaults new chats to native/unknown selection rather than repairing account-observed selection. Changes saved/user-selected model semantics and bypasses the current confirmation contract. |
| #149 | Hold | Adds a 30-second stale-render recovery authority alongside existing model-specific silence recovery. Native Send/quiet prose are not sufficient to override current Pro work policy. Needs reconciliation with current owners and live proof. |
| #146 | Hold | Broad native-input rewrite; its CI invokes `scripts/probe-macos-helper.mjs`, absent from that exact PR head. macOS CI is failing. Already-adapted disabled-permission wording does not validate the remaining native changes. |
| #145 | Hold | Aborts `dispatched-unresolved` based on missing page acceptance signals. Those signals can be delayed; this releases ambiguous-send custody instead of retaining it for exact evidence or user cancellation. |
| #142 | Leave open | Alternative browser feature with different ownership/permission semantics; current browser-control implementation already exists. |
| #124 | Leave open | Draft external controller feature. |
| #120 | Leave open | External persistent-worker controller feature and broad broker changes. |

Nine incorporated/superseded PRs were closed without deleting contributor branches: #192, #195, #201, #216, #227, #231, #232, #234, #245. With the two merges, 28 of the initial 39 remain open. Partial integrations were deliberately left open, not falsely labeled fully fixed.

## Verification

- Isolated public-main integration: focused installer/environment/manager/continuation/resume suites **170 passed, 2 skipped**.
- Full `npm run verify`: **4,649 passed, 43 skipped**, plus **2/2** isolated shutdown tests; exit 0. Typecheck, public-history privacy, dependency license notices and native-source inventories passed.
- Production `npm run build`: passed. `git diff --check`: passed for the accepted integration.
- Unmodified-main Pro regression run: **4 failed, 2 passed**, demonstrating the missing expiry/restore behavior. Patched continuation suite passes.
- Real npm offline tarball before/after test: parent installation reproduced without prefix; generation installation confirmed with prefix.
- Shared local tree after application: same focused suites **170 passed, 2 skipped**; typecheck passed.
- Merged public-main privacy check: passed, 143 commits and 11 tags at the time of checking.
- GitHub readback confirms both exact reviewed heads merged. These PRs had no reported hosted checks; local verification is not represented as cross-platform CI or live provider validation.
- No signed-in browser flow, macOS runtime, installed payload or release validation is claimed.
