# September 18, 2026: Maxim PR follow-up and dirty-tree integration

## Scope and evidence

The live GitHub inventory contained 155 PRs. This pass captured every open PR (37) and every PR by @Maximapple (37), 62 distinct PRs. For each it retrieved the PR metadata, commits, changed files, issue comments, inline review comments and submitted reviews, with pagination. GitHub captures are in the ignored `.tmp/maxim-followup-20260918-23935` directory; they are not source changes or material to publish wholesale.

The actual fork branch behind each of Maxim's 37 PRs was checked as well, including closed and merged PRs. All matched their recorded PR heads except the closed omnibus #78: its branch now ends at `df8b0f95f09cde3174480aad5468ed8eca6a2646`, while the closed PR records `34f57645c48f8835b548ec94276529d422bc3f10`. Its first-parent changes were inspected to distinguish continued fork integration from new focused PR changes. No branch was missing.

The starting local commit was `34653be1`, on `codex/work-2.0.8`. Existing dirty files were copied and hashed before any source edit. Further unrelated edits arrived during this review, so this report distinguishes this task's changes from the evolving shared checkout. Public `main` was fetched for comparison; no branch switch, reset, stash, force push or whole-branch merge was used.

Prior dispositions were cross-checked against `worklog-2026-09-16-pr-audit.md`, `worklog-2026-09-16-pr-bugfix-review.md`, `worklog-2026-09-17-pr-integration.md`, `worklog-2026-09-17-maxim-last-five.md`, `worklog-2026-09-18-maxim-pr-review.md` and the current implementation. An open PR does not mean its useful code is absent: many changes were adapted into later snapshots without merging the original branch. Older unchanged feature holds below are re-evaluated dispositions, not claims of new end-to-end acceptance for those proposals.

## Newly integrated changes

### #295: oversized work whose page reports no running turn

The reproduction is concrete: an exact tool request keeps producing results after the page has lost or failed its local turn; those results push the current context over the threshold. The bridge already records that exact MCP activity, but automatic compaction checked only the page's active turn both before and after storage reads. No new failed-turn event arrives to activate the existing failure exception.

The adaptation reuses the existing `ActivityGrant` for the exact current session/frontend. It must be MCP-backed, unexpired, not marked Thinking-failed, and not dated in the future. The grant is read again after storage yields. Existing policy, blocked/worker/Pro, canonical completion, manual Stop, dismissed-page and superseded-frontend checks remain authoritative. No new blind-page timer, per-request counter or reload reason is added.

This deliberately does not merge #295's stack unchanged: its branch contains the earlier #280 blind-reload subsystem and does not include #280's newest failed-turn exclusion. The demonstrated useful behavior is independent of that stack.

### #284: sustained helper diagnostics

New commit `70237cfd` adds a useful fifteen-second grace. A transient absent/empty observation followed by a healthy one remains quiet. A sustained absence produces one warning; sustained empty data remains informational, because the page may be loading. Recovery is reported only after a degradation was actually announced.

The proposed second `fiberHealthSince` map was bounded only when the announced-state map overflowed. Chats seen once or only during short loading phases could therefore accumulate indefinitely. The adaptation stores current state, onset and announced state in one bounded map, including pre-notice observations, and clears it with the bridge. State changes and backward clock movement restart the grace.

## Updated proposals kept out

#280's new commits `d1bcbc3c`, `47662f41` and `4c34d07d` soften an overconfident diagnosis, handle future timestamps and skip failed page turns. They do not cure the separate detector's underlying evidence problem: two calls separated by minutes are treated as continuous blindness, and its attempt count advances before a browser action is proven. Its useful handout/result logging was already incorporated. The author also corrected the claim that those reloads interrupted the server's work.

#284's discussion retracts the original page-tool-collapse/helper-failure diagnosis and identifies the escaped marker problem covered by #291. All three commits of #291 were already represented in the current shared readers and bootstrap handling. No duplicate marker parser or literal-text unescaping is introduced.

#145's September 17 comment expressly agrees with retaining ambiguous-send custody and points to #274. #274-#278 were closed by their author after checking the existing adaptations. The table retains those distinctions rather than treating every split proposal as an unchanged merge.

## Maxim PR dispositions

| PR | State | Reviewed head | Decision |
|---|---|---|---|
| [#295](https://github.com/totec448-spec/chat-on-steroids/pull/295) | open | `a286779f6fedcabef5c2bf802853ee55a40eb428` | Adapted in this follow-up: existing exact MCP activity now qualifies an oversized current chat without a page turn. No separate blind-work clock or reload policy. |
| [#292](https://github.com/totec448-spec/chat-on-steroids/pull/292) | open | `8e9db4f3e7a9460d7f9746b4fdddf9047d0b0cf6` | Already adapted at this same head. The regression waits for actual completed-output publication and then invokes once; the proposed repeated command attempts remain excluded. |
| [#291](https://github.com/totec448-spec/chat-on-steroids/pull/291) | open | `07d58430e1b86b0019859f21aa2a8da82ae44dac` | All three commits already covered: punctuation-escaped continuation markers, shared readback boundaries and worker bootstrap matching. Current literal brief text and stronger receipt checks retained. |
| [#289](https://github.com/totec448-spec/chat-on-steroids/pull/289) | open | `b012cfd0b20ef27e96f54ab499c5579e9c5f6afe` | Already adapted at this same head: bounded per-chat/per-cause refusal logging, with clock-rollback handling. |
| [#288](https://github.com/totec448-spec/chat-on-steroids/pull/288) | open | `be3fbbc013183e82949b347d622a0c887398280f` | Already adapted at this same head: Windows accessibility probe allowance and its enclosing test deadline. |
| [#286](https://github.com/totec448-spec/chat-on-steroids/pull/286) | open | `e44f9f16ca6266a312ee1a5e10c909d709fccbbd` | Already adapted at this same head: fresh document/claim checks preserve drafts and attachments before ordinary and compaction recovery. |
| [#284](https://github.com/totec448-spec/chat-on-steroids/pull/284) | open | `70237cfd78b80cbc9653daeab16a7b88ad4a7b78` | New commit 70237cfd adapted: fifteen-second grace and recovery only after an announced degradation. One bounded map also includes first sightings; initial unknown and empty-as-information semantics retained. |
| [#280](https://github.com/totec448-spec/chat-on-steroids/pull/280) | open | `4c34d07da3a731be223ebcdb1017e6598bf19bf8` | Handout/result diagnostics already incorporated. New commits d1bcbc3c, 47662f41 and 4c34d07d reviewed. Additional blind-reload loop still excluded: weak continuity evidence, attempts counted before browser action, duplicate activity owner. #295 addresses the demonstrated missed-compaction case. |
| [#278](https://github.com/totec448-spec/chat-on-steroids/pull/278) | closed | `66cd886a8e32a61a835100346d0c8292ac3a2656` | Already adapted: existing durable command custody protects handoff tabs before and after conversation naming. Author closed the PR after checking the integration. |
| [#277](https://github.com/totec448-spec/chat-on-steroids/pull/277) | closed | `e7d631321622c3c114ce4248639d0b1342388e61` | Already adapted: locale-independent usage assertions. Author closed the PR after checking the integration. |
| [#276](https://github.com/totec448-spec/chat-on-steroids/pull/276) | closed | `432883914477ef0b28f9443867080b1950a9fd89` | Already adapted: bounded helper reinjection through existing maintenance. Author closed the PR after checking the integration. |
| [#275](https://github.com/totec448-spec/chat-on-steroids/pull/275) | closed | `fa13af4548037aea40b1cc8a693b9b8c84d2e904` | Already adapted: exact failed-current-turn compaction with final, new-question and binding fences. Author closed the PR after checking the integration. |
| [#274](https://github.com/totec448-spec/chat-on-steroids/pull/274) | closed | `fa50e7fb62ef17177331c5cb44bed4968acb76e8` | Reproduction and exclusive-send regression already incorporated; ambiguous dispatch custody is retained rather than automatically resending an unnamed chat. Author acknowledged the stronger adaptation and closed the PR. |
| [#179](https://github.com/totec448-spec/chat-on-steroids/pull/179) | closed | `e1ddca6f45554c0a29b83e167d199f686525ca10` | Previously adapted: nested authored-block deduplication. No subsequent branch push. |
| [#165](https://github.com/totec448-spec/chat-on-steroids/pull/165) | closed | `a8c7817a8df7d8d2aa5e4ab99b4afe0fa0f07e14` | Previously adapted: release an expired handoff claim through exact durable command/document ownership. No subsequent branch push. |
| [#164](https://github.com/totec448-spec/chat-on-steroids/pull/164) | closed | `32ac1b2c42cf125f69acf3de6acb7705d3166dde` | Previously adapted: replacement checkpoint ownership follows its lease. No subsequent branch push. |
| [#161](https://github.com/totec448-spec/chat-on-steroids/pull/161) | closed | `c1a5c78fbe5473d29e8e41278d43d6e9d6695d07` | Previously incorporated pinned-tab protection. No subsequent branch push. |
| [#160](https://github.com/totec448-spec/chat-on-steroids/pull/160) | open | `4c4d31ace7ec9c75b26f107c9d3d796c93c82eab` | Keep excluded. The diff increments attempts for repeated error observations without proving a reload happened; current recovery already owns actual action receipts and budgets. |
| [#146](https://github.com/totec448-spec/chat-on-steroids/pull/146) | open | `1f83abc5a290284a56080f8eeba1c9d47d6928a6` | Only earlier narrow permission guidance incorporated. Broad macOS physical-input rewrite remains held under the prior build/runtime findings; no fresh code update or new macOS acceptance evidence in this review. |
| [#145](https://github.com/totec448-spec/chat-on-steroids/pull/145) | open | `f20f006cb16ac1b3e6702bd4f33e9546ae5c1cc5` | Keep excluded: missing acceptance signals cannot release dispatched-send custody. September 17 author comment explicitly accepts the hold and points to #274, already adapted. |
| [#142](https://github.com/totec448-spec/chat-on-steroids/pull/142) | open | `4ac9a994d2ce4386c2c7ec7ff92fa0af7d74f531` | Keep separate. Alternative browser-tool implementation duplicates the current owned browser-control path and needs a dedicated replacement/integration decision. |
| [#141](https://github.com/totec448-spec/chat-on-steroids/pull/141) | merged | `6d1bc376520230e03df83066d17bcc9cff81689a` | Merged previously: destinationLost survives relay. Fork branch equals recorded PR head. |
| [#139](https://github.com/totec448-spec/chat-on-steroids/pull/139) | merged | `68f51bb4f2135bf98fa2eae448a8906747994c97` | Merged previously: authoritative enumeration for every-session callers. Fork branch equals recorded PR head. |
| [#131](https://github.com/totec448-spec/chat-on-steroids/pull/131) | merged | `fc59952de6920c4f8d48e1cc82b246fa6d5c4815` | Merged previously: Linux DEB smoke teardown. Fork branch equals recorded PR head. |
| [#117](https://github.com/totec448-spec/chat-on-steroids/pull/117) | merged | `12f9055281ae5f12929ffb3c4e504fa33eb5a0cd` | Merged previously: RTL answer direction. Fork branch equals recorded PR head. |
| [#116](https://github.com/totec448-spec/chat-on-steroids/pull/116) | merged | `506017a73f2a54dc2f61f0d1caec579ad3de1d08` | Merged previously: locale-independent provider-limit verdict. Fork branch equals recorded PR head. |
| [#115](https://github.com/totec448-spec/chat-on-steroids/pull/115) | closed | `38a3fccb13ac7bab20039c49678f03886aef6afd` | Previously incorporated request-scoped caller-evidence wait. No subsequent branch push. |
| [#110](https://github.com/totec448-spec/chat-on-steroids/pull/110) | merged | `71c8a2e8d3aa21176977a169fe3260e0a1c0b9ff` | Merged previously: confirm failed readiness before replacing tunnel client. Fork branch equals recorded PR head. |
| [#88](https://github.com/totec448-spec/chat-on-steroids/pull/88) | closed | `b75a37b23ac0904e667bd8758cef0562d1c93413` | Historical standing-instruction UI proposal; do not restore behavior removed by later product decisions. No subsequent branch push. |
| [#87](https://github.com/totec448-spec/chat-on-steroids/pull/87) | closed | `4d3d523e464ba9659a377076ec8ecde95d04a4bb` | Previously incorporated per-worker model/reasoning schema. No subsequent branch push. |
| [#86](https://github.com/totec448-spec/chat-on-steroids/pull/86) | closed | `9ede4ff6687f2c1561702e73895f571ec5bd6e70` | Previously incorporated exact source-Project continuation. Current one-click/readiness ownership retained. No subsequent branch push. |
| [#80](https://github.com/totec448-spec/chat-on-steroids/pull/80) | closed | `3465d4694a8ed489c6d11ef61b494780783d4447` | Previously incorporated macOS ad-hoc sealing. No subsequent branch push. |
| [#79](https://github.com/totec448-spec/chat-on-steroids/pull/79) | merged | `87a9d9bbdb93f95958f359fa02be6cdcbed37b3a` | Merged previously: Windows swapped-button semantics. Fork branch equals recorded PR head. |
| [#78](https://github.com/totec448-spec/chat-on-steroids/pull/78) | closed | `34f57645c48f8835b548ec94276529d422bc3f10` | Closed omnibus branch advanced to df8b0f95 after the PR was closed. First-parent changes include upstream integrations and the split recovery/health/draft/refusal work reviewed here. Keep split decisions; do not merge its old alternative browser/native code and historical QA wholesale. |
| [#39](https://github.com/totec448-spec/chat-on-steroids/pull/39) | closed | `54c9ba37947508c7f8042e627e85e0c7d43f5e3e` | Previously incorporated running-handoff exclusion. No subsequent branch push. |
| [#38](https://github.com/totec448-spec/chat-on-steroids/pull/38) | merged | `671ebd7bbf68d6b79c7757503748c9f7f198149d` | Merged previously: Project conversation routes. Fork branch equals recorded PR head. |
| [#37](https://github.com/totec448-spec/chat-on-steroids/pull/37) | merged | `2d4a587865718796b32690fc4ad3ce82f428175d` | Merged previously: checked-out-line public-history privacy rule. Fork branch equals recorded PR head. |

## Other open PR dispositions

| PR | State | Reviewed head | Decision |
|---|---|---|---|
| [#272](https://github.com/totec448-spec/chat-on-steroids/pull/272) | open | `7c9d2abaf7c52c761479b24b294e1e08da4e0fd7` | Old maintainer integration snapshot superseded by later published snapshots and current local work; merging it again would add obsolete history. |
| [#267](https://github.com/totec448-spec/chat-on-steroids/pull/267) | open | `7bc90d9005a9b1f67a8c9593a8959a7fe0709fab` | Already adapted in September 17 integration at this exact head: discarded/frozen chat recovery via existing bounded maintenance and fresh document checks. |
| [#264](https://github.com/totec448-spec/chat-on-steroids/pull/264) | open | `9191c720dffaa963b14adc9b018fc51923875c91` | Already adapted in September 17 integration at this exact head: runtime connection diagnostics and sidebar popover. |
| [#263](https://github.com/totec448-spec/chat-on-steroids/pull/263) | open | `80ef2e31e3d80b07b2dcfae909a2426e5f0a0ec3` | Keep held. The diff can pause a plan on another completed turn without matching activatedByTurnId and can hold finish solely because the displayed plan has unfinished steps. Do not mix this lifecycle rewrite into concurrent recorder work. |
| [#260](https://github.com/totec448-spec/chat-on-steroids/pull/260) | open | `75a0bbaca67f4a2689287e3b26eee707d37bc752` | Already adapted in September 17 integration at this exact head: filesystem Skills, metadata, invocation and UI using current boundaries. |
| [#255](https://github.com/totec448-spec/chat-on-steroids/pull/255) | open | `c68c26393411d6e0343a89785baac58ce43b7303` | Separate feature review required: an additional embedded Browser Use authority and UI, not a demonstrated missing fix in the current browser-control implementation. |
| [#254](https://github.com/totec448-spec/chat-on-steroids/pull/254) | open | `9f40d72f007d8f5a935a34938ec905efe75d7a36` | Separate composer/UI redesign; current Skills and slash invocation are already present. No new narrow bug fix identified for this integration. |
| [#252](https://github.com/totec448-spec/chat-on-steroids/pull/252) | open | `c2124d30123bcc084cad12edfe87e3a0df2645a9` | Already adapted in September 17 integration at this exact head: distinct project and standalone-chat sidebar containers. |
| [#251](https://github.com/totec448-spec/chat-on-steroids/pull/251) | open | `762976acd6b0b9f430c1444aa214a3525b8d70a1` | Useful model-discovery custody/startup fixes already adapted at this exact head, retaining exact document/navigation evidence. |
| [#249](https://github.com/totec448-spec/chat-on-steroids/pull/249) | open | `965e622a3fc6ab812895b2216bc70566be98d584` | Separate sidebar redesign; no new narrow correction justified merging the layout replacement into the changing current UI. |
| [#247](https://github.com/totec448-spec/chat-on-steroids/pull/247) | open | `149d3cfbd8abac4bf299a56eb2587540f3ef26eb` | Broad macOS/sidebar chrome redesign stays separate; narrow fullscreen handling had already been incorporated. No fresh macOS UI acceptance performed here. |
| [#246](https://github.com/totec448-spec/chat-on-steroids/pull/246) | open | `6a9ee5a0fef67a6263bdd833c5f43b0cd16ac897` | Maintainer issue-audit/report snapshot, not an additional runtime fix. Retain existing findings rather than merging an obsolete snapshot. |
| [#243](https://github.com/totec448-spec/chat-on-steroids/pull/243) | open | `7d6b234878a4c31618c0162da2cf197dff0c219b` | Already adapted in September 17 integration at this exact head: Traditional Chinese localization. |
| [#242](https://github.com/totec448-spec/chat-on-steroids/pull/242) | open | `9f692a0e731bcb814859bdc8453f0b84b024529a` | Already adapted in September 17 integration at this exact head: project Files workspace, previews/editing and integration boundaries. |
| [#240](https://github.com/totec448-spec/chat-on-steroids/pull/240) | open | `f66203afba65638861fa1f14bffc239e97a04109` | Already adapted in September 17 integration at this exact head: Spanish UI localization. |
| [#237](https://github.com/totec448-spec/chat-on-steroids/pull/237) | open | `4a43ee18cc3874d5fb6f37b627285aa50de54a31` | Separate architecture replacement: app-owned embedded ChatGPT browser. Broad transport/window changes require dedicated acceptance and are not a safe side effect of this PR follow-up. |
| [#229](https://github.com/totec448-spec/chat-on-steroids/pull/229) | open | `07b537dcdec112eeedb0a93bc393fdb9e28c518b` | Keep held: immediate closability includes sleeping workers and bypasses current warm-page/idle grace. Existing worker reuse and closure policy retained. |
| [#224](https://github.com/totec448-spec/chat-on-steroids/pull/224) | open | `34c74ffd4a2ab6dc356c964ba67f848813cad803` | Resume claim-window fix already adapted. Three repeated native Project-link clicks are still excluded; current readiness and single navigation owner retained. |
| [#221](https://github.com/totec448-spec/chat-on-steroids/pull/221) | open | `140ea4da2ac6dd94f69e2f6d1f99934ae8b8c4fa` | Standalone read-only health projection has no runtime consumer in this proposal. Keep for a scoped feature integration rather than adding another unused classification layer. |
| [#220](https://github.com/totec448-spec/chat-on-steroids/pull/220) | open | `99737cc41b942eb7019e0a4b58756558485f70a0` | Earlier late-finish/provisional recovery corrections already adapted. Wider inbox/persistence changes require a separate demonstrated gap; no wholesale merge. |
| [#166](https://github.com/totec448-spec/chat-on-steroids/pull/166) | open | `e443ace2fa57860eae2132b7a313090d4d1d6ee6` | Separate external controller API proposal, not a narrow correction to the connected desktop workflow. |
| [#157](https://github.com/totec448-spec/chat-on-steroids/pull/157) | open | `2f48323072aabba7bd2ce1706fac226acf39de36` | Keep excluded: defaulting to Native/unknown would bypass the current confirmed-model selection contract rather than fixing its observation. |
| [#149](https://github.com/totec448-spec/chat-on-steroids/pull/149) | open | `e0dfac7698d20c2d43039dbead0d49d8b8b79e7f` | Keep excluded: an additional page-watchdog clock duplicates current exact activity, completion and recovery ownership; no fresh code update resolves the prior findings. |
| [#124](https://github.com/totec448-spec/chat-on-steroids/pull/124) | open | `890bb980eba12a37a98c7a80f24a020ac2745b36` | Separate external control/cancellation API proposal; prior scope and ownership review still applies. |
| [#120](https://github.com/totec448-spec/chat-on-steroids/pull/120) | open | `194a4d02b9f283c0b47143a27adf57ea745f74a6` | Separate external persistent-worker controller surface; no narrow adoption in this follow-up. |

## Verification

The initial reproduction produced five expected failures: two missing compaction tickets and
three helper-diagnostic cases. Its five terminal/policy guard cases already passed. After the
adaptations and correct native-request provenance in the completion fixture, all fourteen
focused regressions passed, including grant expiry, clock rollback, Auto Off and frontend rebind
during a paused storage read.

The complete `verify:ci` command sequence was executed with explicit worker limits: the main
Vitest run used `--maxWorkers=2`; the isolated shutdown run used `--maxWorkers=1`. Ripgrep
verification, public-history privacy, third-party notices/native sources, TypeScript and the
Electron availability check all passed. The notices check validated 153 production packages,
7 catalog entries and 730 pinned native source archives/patches.

The first full suite reported **5,253 passed, 4 failed, 45 skipped** across 215 files. All four
failures belonged to the concurrently edited `test/content-script.test.ts`: retaining opened
tool groups across a split, retaining Overwrite during an incomplete Fiber scan, deferring a
virtualized historical remount while scrolling, and preserving the viewport anchor. Source
fingerprints confirmed that `extension/content.js`, `test/content-script.test.ts` and
`test/bridge.test.ts` changed during that run. The four cases all passed on the subsequently
completed shared implementation; this PR follow-up did not alter those Overwrite/scroll fixes.

Both affected suites were then rerun in full:

```text
npx vitest run test/bridge.test.ts test/content-script.test.ts --maxWorkers=2 --reporter=dot
2 files passed; 1,153 tests passed; 0 failed
```

The separate shutdown suite passed **6/6**. A fresh `npm run typecheck`, `npm run build` and
`git diff --check` also passed. Main, preload and renderer production bundles were emitted.
The build retained the existing mixed static/dynamic-import warnings; they did not fail it.
No failure remained in the rerun suites. These are separate recorded runs, not a claim that the
first full-suite invocation exited successfully.

All 537 tracked/untracked verification inputs were fingerprinted around the final suite,
typecheck and build interval, **17:26:27–17:27:09 UTC**. None changed within that interval.
The tested bridge SHA-256 is
`2f6f94824247672c88866101035d2a2620aea4b2cc274e81b41c0b3c99ad93d7`;
its test file is `aa8956d503c36f11a6c05f86068a1974719aa65cb0e1a09d3836ae2165dcc652`.
The initial 16 dirty-file backups still match their saved hashes and all original paths remain
present. The final GitHub inventory comparison found no new PR head, state or discussion
updates since the capture. Logs, fingerprints and comparisons remain in the ignored review
directory for local inspection.

## Attribution and delivery boundary

Behavior and reproductions adapted from Maxim / @Maximapple, especially #295 and #284; `CONTRIBUTORS.md` is updated. Required trailer for a later integration commit:

`Co-authored-by: Maxim <5410641+Maximapple@users.noreply.github.com>`

This task edits `src/main/bridge.ts`, its existing test suite, the applicable in-place `AGENTS.md` sections, `CONTRIBUTORS.md`, and this worklog. It does not claim a release installation, native macOS acceptance, or unchanged merging of upstream PR branches. Existing unrelated changes are retained. No public PR comment or status change is required for the local adaptation.
