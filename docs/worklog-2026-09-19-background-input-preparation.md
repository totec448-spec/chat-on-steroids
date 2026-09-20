# Background input preparation and document routing

The report shows repeated "browser preparation timed out" delivery notices and progress that
resumes when the ChatGPT tab is focused. The maintainer's current setup already works. The
reporter's installed versions, browser configuration and account behavior were not inspected.

## Reproduced causes

The outbox produces this notice when an ordinary claimed browser input remains unauthorized
for 60 seconds. Native preparation was starting in a reused home or catalog tab before the
existing rendering policy included its election. That page does not receive its input marker
until preparation finishes. Two new integration regressions failed with rendering protection
absent at the actual preparation boundary.

The isolated Chromium fixture also demonstrated a second boundary: history.replaceState emits
tabs.onUpdated with both status=loading and the changed URL, followed by status=complete,
without replacing the document. Treating loading as a full reload released the debugger lease
and suspended the animation callback needed for the native handoff. The original mock event
omitted loading and missed this failure. The revised integration fixture reproduced it.

## Implementation

- The durable input election refreshes the existing rendering policy before native preparation
  and input offers. Preparing reuse records the exact document, navigation epoch and source URL.
  The same policy covers its authorized transition to the home composer before the marker exists.
- The background lifecycle owner distinguishes a same-document route using a read-only location
  result from the exact registered Chrome document. Chrome's InjectionResult supplies document
  and frame identity. Missing, mismatched or stale proof remains conservative. This prevents the
  false document retirement as well as the rendering interruption.
- An approved same-document transition updates the existing rendering scope without detaching.
  Cancellation remains cancelled across that transition and worker reconstruction. Full reloads,
  foreign routes, ended work and disconnect retain their release behavior.
- The existing browser-read deadline helper also bounds the identity probe. A frozen page cannot
  hold the serialized navigation queue indefinitely, and its late answer cannot reverse retirement.

There is no new browser, permission, watcher, retry loop or delivery owner. The native Send
authorization, exact receipt requirement, outbox cancellation and one-opening rules remain intact.
Existing unrelated shared-tree edits were preserved. The app and extension version declarations
remain 2.1.14; these changes alone do not establish an installed or published release.

## Validation

The red-to-green checks include hidden home/catalog preparation, the real loading+URL event
shape, approved and foreign route transitions, document replacement, extra navigation epochs,
missing/wrong document/frame/URL proof, frozen reads, late results, debugger cancellation and
release. The initial focused extension run passed 395 tests; seven additional document-read
regressions subsequently passed, including the bounded frozen-read case.

The final real Chromium fixture passed all seven checks: hidden animation resumption,
preserved foreground selection, an unaffected idle neighbor, an authorized same-document
handoff, ended-work release, foreign-route release and a real same-URL document reload.
The target is observed through the scripting API, with no extra observation debugger attached
to it. The recorded hidden animation resumed within 9 ms of acquiring its rendering lease;
this is an isolated fixture measurement, not a provider latency claim.

Final validation completed on 2026-09-20 (local time). The original terminal result confirms
exit code 0 for each of these sequential commands:

- `npm run verify`: 5,514 main-suite tests plus six isolated shutdown tests passed; 45 tests
  were skipped. TypeScript, public-history privacy, dependency notices and native-source
  inventory checks passed. Log: `.tmp/background-robustness-verify-final.log`.
- `npm run build`: main, preload and renderer production bundles built successfully.
  Vite reported non-fatal mixed static/dynamic import warnings. Log:
  `.tmp/background-robustness-build.log`.
- `node scripts/verify-active-tabs.mjs`: all seven real Chromium checks passed. Report:
  `outputs/active-tabs/verification.json`.

The continuation recovered those completed results rather than replaying the jobs. Final
source/diff and regression review required no further production changes; `git diff --check`
passed for the affected files. These are source/test/build results. This task did not package,
install or publish the changes, and the reporter's signed-in ChatGPT environment has not
been retested.
