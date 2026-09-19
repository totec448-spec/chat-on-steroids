# Combined working changes and shell compatibility

The requested publication combines the current working changes with the issue #311 shell fix
in one PR. A separate Git index captured tracked edits and the explicitly reviewed untracked
source/tests/worklogs without changing the shared index or working files. Integration used the
working changes' actual base, retaining the later public fixes already present on main.

The final source includes cold-picker ownership refresh, early complete-stream request identity,
the explicit-root socket-handoff compatibility case, and matched recorder/helper version 18.
It also includes background rendering protection before input preparation and across proven
same-document navigation, Japanese translations, compact native-labeled language flags, and
the associated regression tests and real-browser verification scripts.

Previously integrated model, follow-up, prompt, transcript and recorder changes remain present.
The public worker-wake, journal-timeout and recovery corrections and their contributor credit
are retained. Overlaps with older local copies are resolved to preserve those newer public
behaviors while adding the current working changes. This is a source-tree integration, not a
publication of local Git ancestry, private reporter captures or historical diagnostic scratch.

Validation is performed on the combined tree before publication and installation. The shell
regressions cover exact text, model selection, cold project/worker openings, early correlation,
one native Send receipt, cancellation and wrong-owner rejection. Background tests cover native
loading-plus-URL events, document replacement, missing/late proof and lease retirement. Language
tests cover catalog keys/placeholders, unchanged authored content, persisted selection and native
keyboard behavior. Full repository verification and a new Windows package are required for the
combined source; earlier shell-only results are not reused as that proof.

The combined full verification passed 5,542 main-suite tests and six isolated shutdown tests,
with 45 skipped. TypeScript, privacy, dependency notices and native-source checks passed.
Native Chromium passed all seven background-rendering checks, all 54 setup/header layouts with
keyboard selection and persistence, and all seven shell editing/identity/send checks. The
Windows x64 build, installer and packaged native-runtime smoke check passed on the same source.

A subsequent reporter screenshot showed a handoff waiting for its response. The added shell
source-flow regression reproduced a capture defect: typed final items carry their exact native
message identity but lack the classic thought-parent/time tuple, so the adapter marked the final
unstable and the handoff reader rejected it. The adapter now preserves stable identity only for
that exact completed final in a nonconflicting native conversation. Streaming/cancelled answers
remain weak. The source test checks one dispatch and exact brief capture instead of the previous
answer; the destination test checks native marker commitment before history publication. The
recorder/helper version advances to 18 so old loaded readers are replaced together.
The handoff source/destination and negative cases pass together with 1,073 neighboring tests.
Native Chromium also confirms the completed final retains capture proof. The rebuilt Windows
package and packaged smoke pass. The final full run initially had one Windows capture resource-
state error while 5,546 other tests passed; all 20 tests in that native suite passed when rerun
alone, followed by the six shutdown tests. That failed first run remains in the local evidence;
the unchanged final source is checked again through full verification and all platform CI.

Both the PR's final revision and its merged commit must pass all platform CI checks before
installation. Installed payload hashes and live application/companion checks are separate gates.
The affected-account/NixOS workflow remains for the issue reporters to confirm after updating
the matching app and companion; local fixtures do not establish that remote acceptance.
