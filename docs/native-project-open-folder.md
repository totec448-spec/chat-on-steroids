# Open the saved project folder from the project menu

## User action and boundaries

The local-project menu offers **Open project folder**. The renderer supplies only an existing project UUID to the preload API; the main process resolves the saved project against the *current* approved roots, then calls `shell.openPath` on its canonical absolute directory. The handler does not accept a pathname, select a new root, create a project, or modify a saved project.

Remote projects cannot be opened through this local file-manager action. Unknown project IDs, malformed or extra IPC fields, revoked approvals, missing directories, and inaccessible paths return an error instead of launching the file manager. The project-files resolver also rejects a local project whose stored canonical location is no longer valid. No other project is selected implicitly.

## Last-boundary checks and limitation

The main process resolves the project twice and compares its canonical directory and `stat` device/inode identity. This rejects detectable directory swaps between checks. A symlink or Windows junction redirected outside the approved root is rejected by the existing sandbox resolver; other saved projects do not share the open action's target. If `shell.openPath` reports an OS failure, it is returned as an error.

There is **no claim of OS-atomic path opening**. Node/Electron `shell.openPath` accepts a pathname, not a directory handle, so an adversary capable of replacing that pathname after the final check may still win a narrow time-of-check/time-of-use race. That risk cannot be eliminated by repeating `realpath`; an OS-level handle-relative file-manager API would be required for a stronger guarantee. The command is intentionally limited to an explicit user-selected project-menu action and does not grant the renderer arbitrary shell or filesystem access.

## Review and test matrix

The handler is exercised through the registered IPC channel in `test/ipc.test.ts`. Coverage includes exact saved-directory targeting, sibling project isolation, extra-field and malformed UUID rejection, unknown IDs, revoked root approval, missing directory, OS permission errors, junction/symlink escape refusal, and a simulated directory identity replacement between canonical resolutions. The renderer menu entry, selection and API call are exercised in `test/renderer-timeline.part2.test.ts`.

Before release, run `npm run typecheck`, the two related Vitest suites, and `npm run build`. Validate the feature in an independent user-data directory: approve a root via the normal picker, add a local QA project via the picker, invoke the new menu action, and compare the file manager's actual absolute location with the saved QA project path. Never infer that the installed app has the feature merely because the checkout passes tests.

The upstream project's release process determines how the feature reaches installed users. The documented Windows beta distribution is unsigned and publishes release checksums; do not substitute or patch an installed `app.asar`. No migration of existing user-data or additional root grant is required for the feature.
