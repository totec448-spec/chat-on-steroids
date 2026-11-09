# Current working-tree integration, 2026-09-18

The public candidate starts at `origin/main` commit
`2f9acf307189ed1f05bee0cdc97871fdcff1d8f5` and captures the remaining application,
extension, test and verification-script changes from the current working tree.
The three current ownership, manual-close and history-handoff worklogs are included.
Previously excluded local history, older local-only notes and temporary evidence
remain outside the public branch. Application and extension versions remain 2.1.14.

The changes retain request-owned workspaces, plans, terminals and worker families
until exact chat proof arrives; preserve ongoing work and scheduled recovery when
a browser tab closes; and maintain transcript order, scrolling and manual handoffs
through bounded history reads and exact source ownership.

## Verification

The initial full verification passed privacy, notices, TypeScript and 5,166 tests,
with 45 skipped tests and one failure in the revised-answer pagination regression.
That fixture held `scrollHeight` at 400 pixels regardless of how many rows were
rendered. The new viewport-filling loop consequently kept reading on animation
frames, making the asserted last request depend on machine timing.

The fixture now derives scroll height and row geometry from the rendered rows,
scrolls to the requested edge and lets the animation frame settle. It retains the
assertions that both directions can reach the revised answer, that the canonical
answer appears only once, and that history cursors use original positions rather
than the answer's revision sequence. No production behavior was changed for this
test correction. All 170 tests in the three focused history suites passed.

The final `npm run verify` passed all 5,167 main-suite tests and all six isolated
shutdown tests, with 45 skipped tests. Privacy, production license notices,
native-source metadata and TypeScript checks passed in the same run.
`npm run build` also completed successfully. The captured source files and public
candidate matched byte-for-byte after the fixture correction, with no unexpected
changes detected.

This integration does not install a build or reload the live companion extension.
