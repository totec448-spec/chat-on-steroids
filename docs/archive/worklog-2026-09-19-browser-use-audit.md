# Browser-use audit and fixes, 2026-09-19

## Evidence and scope

Reviewed the 40 most recently updated non-worker conversations with recorded tool activity,
using a frozen cutoff of 2026-09-19T08:53:21.938Z. Their oldest conversation started on
2026-09-17. The audit merged canonical call revisions, read overflow assets, and retained
surrounding calls for every browser failure and tab creation. It contains 6,576 total calls,
266 browser calls and 37 browser failures. There were no malformed rows, missing assets,
clipped source payloads or current-audit conversation rows in this selection.

The complete private selection, call arguments/results, failure chains, relevant app-log
entries and installed/source hashes are under the ignored `outputs/browser-use-20260919/`.
The browser-call snapshot SHA-256 is
`dd3732041beef1e6ecb169359457ce9a6984c5340ba768f8c3bffc33795376e4`.
No private conversation text or identifiers are copied into this worklog.

| Recorded failure | Count | Evidence and response |
| --- | ---: | --- |
| Protected executor tab | 11 | DOM review was often attempted through attachment or the wrong tool. Preserve the existing fixed read path; make it discoverable in Core and Desktop, with DOM details. Protected input remains separate. |
| Foreign attachment | 4 | Include the existing request-to-session proof repair. Foreign DOM inspection remains available without transferring its debugger. |
| Missing attachment | 2 | Reading an existing page must not require acquiring a debugger. The existing inspection path handles this. |
| Stale page observation | 7 | Recorded navigation invalidated the supplied page ID. Preserve the fresh-observation requirement rather than guessing the new target. |
| Closed tab | 8 | The exact target was gone. The records do not establish that every closure came from the user. Do not invent a replacement or erase the original result. |
| JavaScript expression error | 3 | Actual malformed expressions or missing application variables. Explain the expression/IIFE contract and offer fixed DOM diagnostics where suitable. |
| External browser timeout | 2 | Separate browser navigation/snapshot timeouts; the subsequent external page reported a gateway error. |

There were 254 native Desktop browser calls and 12 external browser calls. All nine recorded
`about:blank` observations came from the external browser. Several explicit chains show a
native attachment/read refusal followed by an external browser snapshot on a separate blank
page. Another pattern creates a duplicate ChatGPT tab after an ownership refusal and then
loses that duplicate while the original remains. These records support repairing discovery and
the available read path, not relaxing ownership for arbitrary input.

All 23 native tab creations requested a nonblank URL and returned creation/navigation success.
They do not prove a persistent native blank-page failure. Independently, the current native
implementation still created `about:blank`, acquired its debugger, and only then navigated to
the requested URL. A regression test reproduced how attachment failure strands that blank tab.

## Changes

`extension/browser-control.js` now starts the requested URL directly in `tabs.create`. The
existing readiness wait observes document commit without waiting for all subresources, tracks
the same tab through loading, and removes its listeners on completion or closure. A known
attachment-capacity failure happens before tab creation. Current permission is checked again
before attachment.

Creation and attachment are reported separately. An already-created tab returns `created: true`,
its exact handle and requested navigation even when `attached: false`; `attachmentError` explains
the remaining problem. This is not a loaded-page or successful-attachment claim, and does not
invite repeating `new`.

Tab listings include pending destination, loading status and separate `access.snapshot` /
`access.input` hints. Protected/foreign tabs point to inspection rather than duplicate creation.
The hints do not replace live authorization. Existing request/session aliases, exact page and
frame checks, protected input, debugger acquisition cleanup and permission revocation remain intact.

`browser_snapshot format: dom` adds bounded attributes, rectangles and computed CSS through
the existing isolated-world reader. Noninteractive containers become visible in that format;
text remains the default. It preserves ordinary action refs and inspection isolation, omits
password values and inline handlers, and shares existing traversal/node/text limits with explicit
attribute truncation. Its schema and production transport are tested with screen permission alone.

Core opening instructions and Desktop declarations explain the same-browser read workflow and
the external-browser distinction. A separate plugin browser does not inherit Desktop handles
or repair a protected attachment. JavaScript instructions now explain wrapping statements in an
expression that returns the needed result. No additional tool, permission setting or execution
engine was introduced. The pre-existing internal browser fixes were retained.

## Validation

The new regression suite failed in nine expected cases before implementation; the initial
focused run then passed all 63 tests. The additional invocation-schema case is included in the
complete verification run.

- `npm run verify`: 5,365 tests passed and 45 skipped in the main run, followed by all six
  shutdown tests passing. Total: 5,371 passed, 45 skipped; command exit 0.
- `scripts/verify-browser-control.mjs`: 25 real Chromium check groups passed, including fixed
  DOM details on a protected page, preserved input refs, request-to-session custody, trusted
  background input, screenshots, frames, navigation and direct-URL creation without another blank tab.
- `scripts/verify-browser-control-entry.mjs`: seven groups passed through the production MV3
  entry, authenticated transport and lifecycle; no recorded worker errors.
- `npm run build`: passed for main, preload and renderer. Existing mixed static/dynamic import
  warnings remain warnings; they did not fail the build.
- `git diff --check`: passed. Browser source copies used in both Chromium runs are checked
  against the final working tree in the private verification manifest.

The installed browser-control files differ from the working tree. These results validate source,
tests, build and isolated real Chromium; they do not claim the running signed-in browser has
received the changes. No installation, app restart, publishing or version change was performed.
