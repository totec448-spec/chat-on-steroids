# Read-only Git Changes integration — 2026-09-23

## Scope and provenance

This fork adapts the Git Changes and exact recorded-edit review work authored by
[@Haz4rdovisk](https://github.com/Haz4rdovisk) in upstream PR
[#345](https://github.com/totec448-spec/chat-on-steroids/pull/345), principally source commit
`4f4d3d2b3c87a3ccd199ea3b24c339ca446bd5e6`, onto the fork's upstream-aligned
`main` at `750fad9378a0cf9e37791916b11f7ed9add645dd`.

The focused fork branch is `codex/git-changes-readonly`. It intentionally does **not** port the
feature pack as one unit. This slice includes:

- read-only working-tree `M/A/D/R/U` projection for the selected Local Project;
- file/folder status markers, grouped Changes UI and bounded unified diffs;
- explicit clean, non-repository, binary, oversized and truncated states;
- immutable before/after review evidence for an exact successful recorded `apply_patch`;
- fixed IPC/preload routes and invalidation events for those read-only projections;
- renderer localization across the languages present on `main`: Spanish, French, Japanese,
  Turkish, Simplified Chinese and Traditional Chinese.

Explicitly excluded from this branch are the PR #345 Ask-agent draft action, staging, commit,
reset, checkout and push authority, its plugin-installer repair, and unrelated feature-pack UI
polish.

## Ownership and safety boundary

`src/main/project-git.ts` owns repository discovery, approved-root validation, Git subprocesses,
status/diff bounds and filesystem/Git-metadata invalidation. The renderer receives only structured
project-relative data. Git runs with optional locks disabled, fixed configuration, bounded output
and a deadline; repository root, git-dir and common-dir must remain inside approved roots.

The session recorder separately owns historical edit evidence. Only exact successful patch deltas
can contribute before/after review text. Each retained review is bounded, the per-call total is
bounded, and a storage/quota failure does not turn a successful edit into a failed tool call.
Historical review is addressed by session/call/change identity and does not reread the current
working tree.

## Validation performed so far

- `npm run typecheck` — passed after the focused adaptation.
- `test/project-git.test.ts`, `test/renderer-file-panel.test.ts`, `test/session.test.ts`,
  `test/ipc.test.ts`, `test/preload-images.test.ts` — 299/299 passed.
- The earlier `dev` adaptation passed its FR/JA/TR/ZH-TW/PT-PT localization suites (20/20);
  pt-PT is not on the `main` baseline and is not part of this feature branch.
- `git diff --check` — clean at the focused implementation checkpoint.

- `npm run typecheck` — passed again on 2026-09-24.
- `npm run build` — passed on 2026-09-24; this verifies the source bundle, not an installed app.
- Real Electron/Chromium `scripts/verify-pr-workspace.cjs` — passed on 2026-09-24 with a synthetic
  backend: Changes badge/list, disabled mutation controls and CodeMirror unified diff opened.

The branch has not been pushed or installed. Main-based branch validation is recorded below.

## Main-based branch validation

- `npm run typecheck` — passed on 2026-09-24.
- `test/renderer-file-panel.test.ts` — 39/39 passed on 2026-09-24.
- `test/session.test.ts` — 171/171 passed on 2026-09-24.
- `test/project-git.test.ts`, `test/renderer-timeline.test.ts`, `test/ipc.test.ts`,
  `test/preload-images.test.ts` — 278/278 passed on 2026-09-24.
- Git subprocess environment redirects were subsequently stripped at the owner boundary;
  `test/project-git.test.ts` then passed 6/6, including the new inherited-redirect regression.
- `npm run build` — passed on 2026-09-24.
- `npm run verify:notices` and `npm run verify:privacy` — passed on 2026-09-24.
- Real Electron/Chromium `scripts/verify-pr-workspace.cjs` — passed on 2026-09-24 with a
  synthetic backend. Its Changes list and unified diff screenshots were inspected visually.

An initial repository-wide `npm run verify` started before that last source/test change was
loaded. It ran 5,882 tests: 5,829 passed, 7 failed, 46 skipped. One failed Git redirect
regression observed stale pre-fix source in that long-running process and passed in a fresh
focused run; six unrelated Code Mode, Windows accessibility, Continue and PowerShell tests
also failed. A second full run against the final source ran 5,882 tests: 5,830 passed, 6
failed, 46 skipped. The Git regression passed. Its failures were Windows accessibility (2),
PowerShell parser recovery (1), plugin-manager timing/ownership (2) and timeline pagination
(1). The timeline pagination case passed when rerun alone (1/1). The full repository gate is
therefore not green and should be resolved or clearly scoped before an upstream PR.

`npm run dist:dir:x64` produced an unpacked Windows x64 package on 2026-09-24.
`scripts/smoke-packaged-runtime.mjs --platform win32 --arch x64` passed for the package's
resources and native runtimes. This does not prove the app was installed or the Git Changes
flow ran against a live provider account. No installer was run.
