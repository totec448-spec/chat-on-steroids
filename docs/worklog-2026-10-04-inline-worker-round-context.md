# PR #1066: keep worker inspection in its round context

Adapted the review direction from Maximapple and Haz4rdovisk on
[#1066](https://github.com/totec448-spec/chat-on-steroids/pull/1066), retaining
redzrush101's original feature commits and #961 attribution. Merged current main
at `eedafea` without rewriting those commits; resolved the project-focus conflict
by retaining main's exact focused-control restoration.

Activity-round summaries now show the participating workers' existing avatar
colors and open their inline history. The index and inspected-worker header link
back to those rounds on the loaded timeline page. Participation comes from
recorded communication, successful messages and complete structured spawn
receipts. Status rosters, foreign families, rejected/truncated calls and ambiguous
worker names cannot create a link. Worker-pane event keys include their session
identity. Unchanged round controls stay mounted so refresh preserves keyboard focus.

The inline history has a `min(360px, 45vh)` scroll viewport with contained
overscroll. Opening it releases the existing follow-output/send hold as an
explicit reading action; worker refresh does not release the hold again, and
Jump to latest resumes following. History selection remains independent of the
dock and prime composer. Retired full-chat/round controls cannot navigate after
parent changes, including A → B → A.

The real-Electron fixture now shows three rounds, two workers and a 48-message
worker history. It checks lazy loading, contained native wheel input, stable
main/worker reading positions during prime output and worker refresh, exact round
navigation, preserved composer text, independent dock selection, resumed
following and narrow layout. The fixture clones IPC replies and waits for actual
wheel/smooth-scroll completion. All conversation text is synthetic; no provider
account or credentials are used. `long-collapsed.png` and `long-open.png` in
`docs/screenshots/inline-subagent-cards/` show the same turn with several tool
calls and worker messages above the secondary card.

Validation on x86_64 Linux/NixOS:

- Focused suites initially passed 267 tests. Final targeted identity/navigation
  checks passed 7 tests, including retained focus and no re-entry on refresh.
- `npm run verify` passed: 7,069 tests passed, 156 skipped, plus privacy,
  notices, typechecking and Electron resolution. Used four CPUs and CI's existing
  `COS_TEST_RETRY=1` setting.
- Final production build and dedicated Electron fixture passed. `git diff --check`
  and public-history privacy passed.
- Full `npm run verify:ui` ran all 41 checks: 35 passed initially. Accessibility
  passed after supplying the lockfile-pinned axe-core 4.13.0 dependency, with its
  archive integrity verified; the pet overlay passed on a separate rerun.
  The opening-scroll, reactions and terminal checks fail on unchanged main under
  the same local runtime. The shell runtime check cannot run without an available
  Chromium executable. None of these assertions was suppressed or weakened.

This is source, regression, production-build and isolated Electron evidence.
Packaged installation and signed-in provider behavior were not exercised.
