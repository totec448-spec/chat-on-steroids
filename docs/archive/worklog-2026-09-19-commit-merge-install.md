# Workspace integration and installation, 2026-09-19

The user authorized committing, opening a pull request, merging and installing the current
shared workspace. The candidate was captured from local `2d87e689` at 09:47 UTC on top of
public main `0a017b54`. Its 47 changed/new files and all 805 candidate files were hashed.
No source changed during capture. Older local-only history was not included in the public branch.

## Included changes

Browser reviews can inspect existing protected or foreign tabs through the fixed DOM reader.
New tabs start their requested URL independently of debugger attachment, and results distinguish
creation from attachment. Exact request-to-session proof preserves the owning browser lease.

Windows observations expose minimized state, bounded targeted accessibility searches and
independent pixel/accessibility failures. Semantic controls without pixel bounds remain
actionable through their actual native patterns. Key parsing and operational errors now give
usable correction guidance without implying a global permission failure.

Recovery retains the source question's work identity across reload reserialization, retires
departed-chat Continue waits without losing exact late receipts, and reports concrete cancellation
reasons. Completed response sections reconcile to their exact current question. Interim prose
keeps its response grouping in history, while cancelled automatic drafts retain their chronology.

The integration retains the adapted contributions from PRs #298, #299, #305 and #308, with
GitHub-linked co-author trailers and the existing CONTRIBUTORS explanation. It does not include
the separate macOS proposal in #309.

## Candidate preparation evidence

The public candidate has its own dependency copy and separate build/output directories.
The complete `verify:ci` command was executed with only the Vitest worker count limited to two.
Ripgrep staging, public-history privacy, third-party notices, native source checks and TypeScript
passed. The main run passed 5,379 tests, skipped 45 and failed one ambient Windows assertion
in `test/computer.test.ts`: no mapped element centre was available in its selected desktop
window. That test selects the currently visible user window rather than an owned fixture.
The entire unmodified 20-test file then passed with one worker. This is recorded as a
desktop-dependent test result, not a successful first full-suite run.
All six separately executed shutdown tests and all five opt-in live plugin acceptance tests
also passed, including actual Blender, Unity, Playwright, Memory and Fetch server paths.

The real Chromium browser-control verifier passed, including protected DOM inspection and
direct-URL creation. The production extension-entry verifier passed with no worker errors.
The production queue UI passed all 15 cases. The real Windows helper/facade smoke passed
using owned WPF fixtures with software rendering, production capture, actual semantic/physical
input and restored clipboard. The foreground and unrelated-window checks passed.

The main/preload/renderer build and Windows x64 NSIS package completed successfully at 09:54 UTC.
App and extension remain version 2.1.14. This preparation record does not claim installation
or that the signed-in browser already runs the changed extension.

The pull request's head checks record the final cross-platform verification. Installation is
performed after the merge and uses the exact checked installer. Local receipts compare every
packaged file, extension mirror file and built bundle, then execute the installed native runtime
probe and confirm the restarted application. The private shipping evidence, immutable installer,
logs and hash manifests remain in the ignored `outputs/ship-20260919-95933/` directory.
