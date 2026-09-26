# Contributing

Chat On Steroids is a Windows/macOS/Linux beta maintained by one person. Bug reports, focused fixes and concrete improvements are welcome.

## Before a pull request

For anything non-trivial, open an issue first so the intended behavior is clear. Security problems must be reported privately through [`SECURITY.md`](SECURITY.md), not as an issue or PR.

Keep changes narrow. Preserve existing permission, identity and recovery behavior unless the issue specifically requires changing it. Avoid unrelated formatting, generated output, local debugging material and private data. In screenshots, logs and examples, replace real usernames, local paths, chat text, IDs and credentials with obvious placeholders such as `C:\Users\you\project` or `/home/you/project`.

## Responsible-use expectations

Contributions and examples should follow the [responsible-use notice](README.md#responsible-use-and-provider-rules). Do not propose or promote bypassing provider safety decisions, usage limits or account restrictions. Describe browser automation and recording accurately; do not market CoS as a way to avoid quota. Claims about usage allowances or OpenAI approval require evidence. Keep account notices, appeals and private conversation evidence out of public issues, PRs and documentation. These expectations do not alter the MIT license or replace any provider's terms.

## Development setup

Development uses Node 24 LTS and is supported on Windows, macOS and Linux. `nix develop` supplies Node and build tools on Linux and macOS. Desktop/computer-use has platform-native Windows and macOS helpers behind one protocol; Core, extension, sessions, agents and tunnel behavior must stay portable. macOS helper changes require Xcode/Swift and a packaged arm64 or x64 smoke check.

```sh
npm ci
npm run verify     # the same gate CI runs
npm run dev        # Electron development build
```

A behavior change should include a deterministic regression test where practical. Run the nearest focused tests while working and `npm run verify` before submitting.

## Packaging

Release packages are platform/architecture-specific. For example:

```sh
node scripts/package.mjs --platform win32 --arch x64
node scripts/package.mjs --platform darwin --arch arm64
node scripts/package.mjs --platform linux --arch x64
```

Release CI builds and smoke-tests every platform/architecture on a native runner. Packaging downloads/stages pinned external assets and verifies their checksums, so the first packaging run needs network access. Do not claim a cross-OS package is validated merely because electron-builder can sometimes emit it from another host.

The [build guide](docs/build.md) covers all build, test and Nix commands.

## Pull requests

Explain the root cause, the smallest behavior change that fixes it, and exactly how you validated it. Packaging/runtime changes should include a packaged-runtime smoke check where relevant.

## Credit and attribution

Contributors retain credit when their patches are adapted, rewritten or consolidated into release snapshots. Merge the original PR when appropriate and preserve its author. For adapted work, link the original PR, explain what was incorporated, and include the original contributor in the integration commit's `Co-authored-by` trailers using their public GitHub noreply identity. Verify the resulting commit resolves to the intended GitHub account.

Record incorporated work in [CONTRIBUTORS.md](CONTRIBUTORS.md). Credit bug reports, designs and review explicitly, distinguishing them from incorporated code. Closing a PR as incorporated or superseded must explain that distinction and link the integration; it must not erase attribution. AI-assisted integration does not transfer the original contributor's credit to the maintainer or the model.

Contributions are accepted under the MIT licence in [`LICENSE`](LICENSE).
