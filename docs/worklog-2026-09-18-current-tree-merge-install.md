# Current source snapshot, PR integration and installation order

The user requested committing the complete dirty source tree, integrating it through
GitHub, and installing the result. Installation is explicitly the last operation
because replacing the running application can interrupt its tool connection.

The existing PR #293 provides the public-main-based integration branch. Its pending
renderer and finish-input fixture corrections were preserved and applied to the newer
shared source: history tests await an actual animation frame, and the finish test
awaits provider admission while retaining cleanup for an unfinished request.

This snapshot includes the current request ownership, plan, terminal, worker-family,
manual-close recovery, model-specific inactivity, queue/Continue, handoff and transcript
changes. The recovery timing audit and Maximapple review worklogs describe those owners.
Contributor credit for adapted PRs #280, #284, #286, #288, #289, #291 and #292 is retained.
Temporary diagnostic files stay in the ignored `.tmp` directory. Previously excluded
local-only history is not added to the public branch by this source snapshot.

## Additional failure found during integration

The first complete run reported a native desktop foreground assertion and a lost
disclosure identity when React replaced an assistant section. The native test passed
all 20 cases in isolation. The remount failure was reduced to a deterministic intermediate
paint before Fiber supplies the replacement's exact identity. Disconnection had retired
the old record immediately despite its existing replacement grace.

Detached disclosure state now remains within that bounded grace. Reclaiming it still
requires exact call/message proof; expiry and Overwrite Off retire it. The regression
checks both immediate and delayed identity delivery without weakening its original
node-identity, expansion-state, chronology or duplicate assertions. All 657 content-script
tests passed after the correction.

## Local validation

The complete `npm run verify` gate passed with `VITEST_MAX_WORKERS=2`: **5,220 main-run
tests passed, 45 skipped**, followed by **all six isolated shutdown tests**. Privacy,
dependency/native-source notices and TypeScript checks passed in that same gate.

The Windows x64 package completed for version **2.1.14**. Packaged-runtime verification
passed for Electron 44.3.0, Sharp 0.35.4/libvips 8.18.6, node-pty and tree-sitter, together
with the required bundled command-line tools and licenses.

GitHub checks and the final merge are verified against the public PR head separately.
The installer is held until that work completes. An independent local helper records
the installer exit, application restart, installed/package hash comparison, stable
extension mirror, archive bundle comparison and installed-runtime smoke result. Those
results do not claim that every already-open native ChatGPT document loaded new code.

Logs remain local in `.tmp/install-merge-verify-final.log`,
`.tmp/install-merge-package.log`, `.tmp/install-last-result.json` and
`.tmp/install-last-proof.json`; the last two are created by the final installation.
