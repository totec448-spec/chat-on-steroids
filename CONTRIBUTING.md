# Contributing

Chat On Steroids is a Windows/macOS/Linux beta maintained by one person. Bug reports, focused fixes and concrete improvements are welcome.

## Before a pull request

For anything non-trivial, open an issue first so the intended behavior is clear. Security problems must be reported privately through [`SECURITY.md`](SECURITY.md), not as an issue or PR.

Keep changes narrow. Preserve existing permission, identity and recovery behavior unless the issue specifically requires changing it. Avoid unrelated formatting, generated output, local debugging material and private data. In screenshots, logs and examples, replace real usernames, local paths, chat text, IDs and credentials with obvious placeholders such as `C:\Users\you\project` or `/home/you/project`.

## Responsible-use expectations

Contributions and examples should follow the [responsible-use notice](README.md#responsible-use-and-provider-rules). Do not propose or promote bypassing provider safety decisions, usage limits or account restrictions. Describe browser automation and recording accurately; do not market CoS as a way to avoid quota. Claims about usage allowances or OpenAI approval require evidence. Keep account notices, appeals and private conversation evidence out of public issues, PRs and documentation. These expectations do not alter the MIT license or replace any provider's terms.

## Development setup

Development requires Node 22+ and is supported on Windows, macOS and Linux. Desktop/computer-use has platform-native Windows and macOS helpers behind one protocol; Core, extension, sessions, agents and tunnel behavior must stay portable. macOS helper changes require Xcode/Swift and a packaged arm64 or x64 smoke check.

```sh
npm ci
npm run verify     # the same gate CI runs
npm run dev        # Electron development build
```

On Linux with Nix installed, the repository also has a flake-based development shell. It uses
Node 22 to match CI, derives the Electron major from `package.json`, and imports npm dependencies
from the integrity hashes already stored in `package-lock.json`, so there is no second npm
dependency hash to bump.

The Nix shell has been built and tested on `x86_64-linux`. `aarch64-linux` has only been
evaluated, not built or tested.

```sh
nix develop
npm run verify
npm run dev
```

The Nix shell owns its `node_modules` symlinks. When changing dependencies, update the manifest
and lockfile with `npm install --package-lock-only ...`, then re-enter `nix develop`. If you are
switching an existing checkout from a regular `npm ci`, remove that generated `node_modules`
directory once before entering the Nix shell. `flake.lock` is the only Nix-specific dependency
pin; Nix contributors can update it in their own pull requests with `nix flake update`.
Run `npm run tunnel` when working on the OpenAI tunnel path; the shell already provides ripgrep
for normal development fallback discovery.

A behavior change should include a deterministic regression test where practical. Run the nearest focused tests while working and `npm run verify` before submitting.

## Packaging

Release packages are platform/architecture-specific:

```sh
npm run dist:x64
npm run dist:arm64
npm run dist:mac:x64
npm run dist:mac:arm64
npm run dist:linux:x64
npm run dist:linux:arm64
```

Release CI builds and smoke-tests every platform/architecture on a native runner. Packaging downloads/stages pinned external assets and verifies their checksums, so the first packaging run needs network access. Do not claim a cross-OS package is validated merely because electron-builder can sometimes emit it from another host.

## Canary builds

The `canary` prerelease is a test build of `main`, rebuilt automatically after every change to `main` that can affect the app (documentation and test-only changes are skipped). A newer build replaces the previous one. It has no release notes and no support. Issues and pull requests are accepted only for problems that also happen on the latest stable release.

## Issues

A bug report needs the exact app version, for example `2.1.32` (Settings → Activity in the app). "latest" is not enough: it changes with every release. A report without a version number is closed with the `needs-version` label and reopens by itself when the number is edited in.

Issues are closed as soon as their fix is merged to `main`; the fix ships with the next release. When an issue is labeled `needs-info`, it waits for details from the reporter: after 7 days without a reply it gets one reminder, and 3 days later it is closed. Reply or reopen at any time with the details.

## Pull requests

This project is maintained by one person, so review time is the scarce part. A PR is reviewed only when **CI and the "PR checklist" check are green**. The checklist runs automatically on every PR and on every edit of its description; its log says exactly what is missing. Use the pull request template and it passes by itself.

Maintainers are happy to fix small things before merging, but they do not build out, debug or finish a change from scratch, and a pull request whose checks fail is not reviewed until you fix it. AI-assisted contributions are welcome when you have run, understood and tested every line yourself: you are responsible for the whole change, and a PR is not a request for someone else to finish it.

What every PR needs:

1. **Why and what, in the PR itself.** The root cause or user problem, and the behavior change, in a few sentences each. No separate issue is needed; discussion happens on the PR. When it closes an issue, write `Fixes #123` so the issue closes on merge. For anything beyond a small fix, open a draft PR early and agree on the behavior there before building it out.
2. **A test that fails without the change.** Name it in the PR. The "Fail-first test" check proves it: it runs your changed tests against `main`'s code, and at least one must fail there. Only when a test is truly impossible, write `No test: <reason>`; when your tests only follow a refactor, write `Fail-first: n/a <reason>`.
3. **Screenshots for interface changes.** Before and after, with placeholder data. Run `npm run verify:ui`. When renderer code changes but nothing on screen does, write `No visual change: <reason>` instead.
4. **One topic, small.** At most 600 changed lines outside tests and translations. Split larger work, or state `Large change: <reason>` and expect a slower review.
5. **Clean contents.** Nothing unrelated: no worklogs, notes, logs, formatting-only edits or generated output. Rebase on `main` when it conflicts.
6. **Green checks.** `npm run verify` passes on your machine. Say which OS you ran it on. Packaging/runtime changes also need a packaged-runtime smoke check.
7. **Docs with contracts.** A change to the preload API, IPC handlers or `src/shared` types updates the matching part of [`AGENTS.md`](AGENTS.md) in the same PR, or states `No contract change: <reason>`. The same applies to new recorded fields, bridge routes and extension messages.
8. **Maintainer edits allowed.** Keep "Allow edits by maintainers" on, so a maintainer can make a small fix before merging instead of another review round. Your authorship stays. It is not a way to leave work unfinished.
9. **No stacks out of order.** A PR that builds on another one says `Depends on #N` and stays a draft until #N is merged; then rebase it on `main`.

What reviews look for, beyond the checks:

- **Every change serves the linked issue.** No extra behavior changes "while at it", even small ones; open a separate issue for them.
- **Nothing depends on ChatGPT's wording.** Decide behavior from structure, ids and machine fields, never from visible English text. ChatGPT is used in many languages; if text is unavoidable, include a non-English case in the test.
- **Interface changes are checked in the real app.** Besides `npm run verify:ui`, run the change in a real build and show it in the screenshots or a short clip.
- **Answer review comments or fix red checks when you can.** After 3 quiet days a bot leaves one friendly reminder, and 3 days later it closes the PR. If only a small fix is missing, a maintainer may finish it instead. Any push or reply, even "I need more time", resets the clock, and a closed PR can be reopened at any time.

## Credit and attribution

Contributors retain credit when their patches are adapted, rewritten or consolidated into release snapshots. Merge the original PR when appropriate and preserve its author. For adapted work, link the original PR, explain what was incorporated, and include the original contributor in the integration commit's `Co-authored-by` trailers using their public GitHub noreply identity. Verify the resulting commit resolves to the intended GitHub account.

Record incorporated work in [CONTRIBUTORS.md](CONTRIBUTORS.md). Credit bug reports, designs and review explicitly, distinguishing them from incorporated code. Closing a PR as incorporated or superseded must explain that distinction and link the integration; it must not erase attribution. AI-assisted integration does not transfer the original contributor's credit to the maintainer or the model.

Contributions are accepted under the MIT licence in [`LICENSE`](LICENSE).
