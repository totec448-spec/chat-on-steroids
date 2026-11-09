# Selective PR review, September 20, 2026

Reviewed four external PRs against local base `9a532ff4`. The existing usage UI changes were
left intact. This is a source integration; no commit, remote merge, release or install is implied.

| PR | Reviewed head | Decision |
| --- | --- | --- |
| [#331](https://github.com/totec448-spec/chat-on-steroids/pull/331), cXSHoz | `76de25ca99f392746a4512ef0dd91ea6da6201eb` | Incorporate the one-line catalog translation in `dom.run()`. |
| [#324](https://github.com/totec448-spec/chat-on-steroids/pull/324), Maximapple | `bfee178667e51728d5374ff19f174231e3cf42bd` | Adapt the shutdown fix with one shared teardown and explicit late-handle retirement. |
| [#325](https://github.com/totec448-spec/chat-on-steroids/pull/325), Maximapple | `e88a210ecbf98dd379f2f9c915b94748ef8adbaa` | Do not incorporate the immediate exit/kill chain. |
| [#309](https://github.com/totec448-spec/chat-on-steroids/pull/309), Masatoshi Shisaka | `1fa5383b71a1dc39f32c6ba74750a0e2cd2e2f0e` | Incorporate only the contradictory AX window-ID guard. |

## Integration decisions

**#331:** App-owned errors that already have a catalog entry now use the selected language.
Unknown errors, whitespace, literal markup and successful IPC payloads are preserved.
The regression failed on the previous source and passes after the change.

**#324:** Final shutdown previously queued behind asynchronous credential/startup work, so
an unresolved lookup could prevent the endpoint from even beginning its shutdown. Quit now
enters the existing teardown directly. All callers share that teardown through HTTP drain
and tunnel retirement; ordinary Disconnect keeps its unforced drain and remains reconnectable.
Late endpoints and Core/Plugins tunnel handles are retired without reviving connection status.
Late transports remain alive until accepted responses drain.

The proposed five-second grace and competing teardown race are unnecessary once final shutdown
has one owner. Keeping disabled optional tunnels alive is a separate policy change and was
not adopted. In particular, preserving a handle while setting its card to `off` needs a complete
disable/re-enable state transition, which that PR's test did not verify.

**#325:** Electron 44.3.0's [`lib/browser/init.ts`](https://github.com/electron/electron/blob/v44.3.0/lib/browser/init.ts)
maps `process.exit()` to `app.exit()`. Its [`shell/browser/browser.cc`](https://github.com/electron/electron/blob/v44.3.0/shell/browser/browser.cc)
posts the message-loop quit task during normal shutdown. The second call is not an independent
hard exit, and a returned call does not prove that shutdown failed. An isolated local Electron
44.3.0 process recorded `before-app-exit`, `quit`, `returned-from-app-exit`, then exited normally
with code 0 and no signal or timeout. The PR's immediate chain would reach its kill step in
that healthy case. Its callback-order mocks do not establish a hung-process recovery guarantee.
The reported Mac hang remains a useful report, but this change does not isolate its cause.

**#309:** An AX element with a different explicit window number could previously win by matching
the requested window's geometry. Geometry now fills absent identity only. Exact matches and
unambiguous windows without an AX number still work; ambiguous and unrelated candidates fail.
The larger off-Space discovery, focus and pointer/keyboard admission rewrite remains open.
The author's follow-up fixes earlier review objections, but its negative cases are source-shape
assertions and the follow-up explicitly lacks fresh physical floating-window acceptance.
This review does not mark #307 or the full #309 proposal fixed.

## Validation

- Initial regression run: three failures reproduced the IPC-language error, parked-lookup
  shutdown and delayed optional-tunnel shutdown; 26 existing checks passed.
- The first integrated connection/localization/shutdown run passed all 39 checks. Additional
  cases cover late Core and Plugins handles during an accepted-response drain, and startup
  results arriving after final shutdown has completed.
- A portable Swift fixture executes the actual production matching and geometry functions
  with synthetic AX responses. The pre-change program failed on contradictory identity;
  the corrected program passed all six cases. The exact generated program was compared
  between the Windows source tree and the Linux Swift runner using normalized UTF-8 SHA-256:
  before `fb3901b93abebdb5675a93ada95d79c73d4cf0d3e3d7c05b08684b86f5e7afe8`,
  after `d9ada19074883b5c55f77f5fd03e3e49819575765c83fc71c6ff622b0cd6cdc9`.
  `test/macos-window-matching.test.ts` runs this fixture where Swift is available and skips
  explicitly otherwise. This is native matching-policy evidence, not an AppKit/AX integration
  test or a full Mac build/live-input claim.
- Upstream CI snapshots: #324 and #309 success; #325 failure; #331 action required.
  These do not substitute for checking the adapted local tree.
- Full local verification and build results are recorded below when complete.

## Authorship for the eventual integration commit

No commit was created in this review. Preserve these verified public GitHub identities when
committing the incorporated/adapted changes:

```text
Co-authored-by: cXSHoz <212483155+cXSHoz@users.noreply.github.com>
Co-authored-by: Maxim <5410641+Maximapple@users.noreply.github.com>
Co-authored-by: Masatoshi Shisaka <313313203+okayamajwcc-coder@users.noreply.github.com>
```
