# Pairing, Skills and continuation review

## Reviewed contributions

| PR | Reviewed head | Decision |
| --- | --- | --- |
| #331 | `76de25ca99f392746a4512ef0dd91ea6da6201eb` | Integrate the contribution and retain the existing broader catalogued IPC-toast handling. |
| #334 | `3a9da9606a9c956f425b57d8af74fb2ebc90f8e2` | Integrate approved top-level Skills package links, canonical target checks and package containment. |
| #335 | `7b9b2a26e665cc348a444896a14bf7d164260197` | Leave open: restores a general instructions editor that the current product contract intentionally removes. |
| #337 | `aa19552f4ff666eb717bf9b24184f6bfe3593cd3` | Integrate Auto/8765–8769 bridge selection, transactional listener replacement and lifecycle tests. Preserve the newer local translations. |
| #340 | `37c5f41b9ac742f4303df3c8e867f559cd08daec` | Integrate pairing serialization/reuse, source hydration, login-shell PATH and explicit tunnel-selection fixes. |
| #341 | `2e85435d6542edf217a9db4fa22cc1129bf5319b` | Leave open: includes a machine-specific node_modules symlink and bypasses durable compaction refusal using a work-stopped boolean rather than renewed exact turn authority. |

#342 was already on the public main line before this review. Its shell request attribution,
resumed-turn recording and public interim-message capture remain included. Private local
history and operational evidence are excluded from the public integration.

## Reproduced failures and changes

Before the production changes, the focused regression run failed 12 cases. Six simultaneous
automatic pair requests issued six different tokens. A delayed credential write could report
pairing success after Disconnect had superseded it. A recovered source whose original question
had not hydrated could fail to send its handoff or begin preparation against the wrong source.
The new checks also exposed unsupported approved Skills aliases and silent fallback from an
invalid explicit tunnel binary choice.

Automatic pairing now shares the current credential generation; explicit reconnect retains
rotation. Credential publication serializes with revocation. Compaction waits for the existing
question and editable composer while preserving real Send, navigation, cancellation and dispatch
boundaries. Approved Skills links do not extend ordinary root authority or learn a workspace.

The extension popup no longer offers Advanced → Disconnect. An installation already deliberately
disconnected retains Connect, and the durable revocation/API semantics remain intact.

## Issue assessment

- #339 describes a listening bridge without successful extension pairing. The concurrent-profile
  defect is independently reproduced and corrected, but the report lacks the diagnostic evidence
  needed to establish that it is this reporter's specific cause.
- #336 describes hours of recovery without resumed tools. Existing exact-source silence and
  outbox recovery remain authoritative. A reload receipt is not a resumed model/tool receipt.
  Pickup retries slow through 2/5/10/15 minutes and retain the original 12-hour expiry; page
  activity does not renew that expiry. The source-hydration fix closes a separately reproduced
  failed-continuation path. The report alone does not prove every hour-long stall is resolved.
- #330: automatic compaction may intentionally interrupt an active task at the configured
  threshold. Handoff/resume must preserve the task; disabling compaction or bypassing a refusal
  would not repair a failed handoff.
- #333 is addressed by the approved Skills link implementation and its containment tests.
- #338: existing setup profiles live under Appearance. Automatic account rotation on rate limits
  is a different capability. The user had already posted the product pointer; no new comment
  was sent during this review.
- #320: Japanese is already available. CONTRIBUTORS.md now explicitly credits Masatoshi Shisaka
  (@okayamajwcc-coder) for the proposal and offer to translate, without misattributing the code.

## Verification recorded during integration

The first combined regression run passed 1,508 tests across bridge, extension/content, popup,
Skills and tunnel-location suites. The added port/lifecycle/config/IPC/renderer/shell run passed
225 tests with three host-inapplicable POSIX cases skipped on Windows. Each selected upstream
head had successful Windows x64, macOS arm64 and Linux x64 CI before integration.

The public candidate is validated and packaged separately from the shared private checkout.
Build, package, installation and active-browser evidence are distinct from these source/test
results; operational receipts stay in ignored output folders.
