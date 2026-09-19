# Combined working changes and shell compatibility

The requested publication combines the current working changes with the issue #311 shell fix
in one PR. A separate Git index captured tracked edits and the explicitly reviewed untracked
source/tests/worklogs without changing the shared index or working files. Integration used the
working changes' actual base, retaining the later public fixes already present on main.

The final source includes cold-picker ownership refresh, early complete-stream request identity,
the explicit-root socket-handoff compatibility case, and matched recorder/helper version 17.
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

Both the PR's final revision and its merged commit must pass all platform CI checks before
installation. Installed payload hashes and live application/companion checks are separate gates.
The affected-account/NixOS workflow remains for the issue reporters to confirm after updating
the matching app and companion; local fixtures do not establish that remote acceptance.
