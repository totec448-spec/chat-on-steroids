# Working on Chat On Steroids

Chat On Steroids is an Electron workspace for ChatGPT. The desktop app owns local files, processes, settings, sessions, and MCP tools. A browser extension observes and controls the ChatGPT page. ChatGPT runs the model; the app does not.

This file is a short guide for coding agents. Use the current source and tests for implementation details, [the build guide](docs/build.md) for commands, and [the tool reference](docs/tool-surface.md) for connector behavior. Do not treat an old document or test as proof that the current app behaves as intended.

## Start here

- Check `git status --short` and the diff of every file you plan to edit. This tree may contain someone else's unfinished work. Preserve it; do not reset, clean, or broadly reformat the tree.
- Read the implementation at the first boundary that owns the behavior. Fix that boundary and remove obsolete branches instead of adding another fallback, watcher, timer, or mirrored state.
- For browser behavior, inspect current page or extension evidence when possible. Source and mock tests alone cannot prove a live ChatGPT flow.
- Follow any closer `AGENTS.md` in a subdirectory and the user's current instructions.

## Code map

| Area | Start with |
| --- | --- |
| Electron lifecycle, settings, permissions, IPC | `src/main/index.ts`, `config.ts`, `sandbox.ts`, `ipc.ts`; `src/preload/` |
| Local tools and MCP connectors | `src/main/mcp/`; `src/main/{fsops,exec,projects,workspace}.ts` |
| Sessions, input, history, Goal/Loop, workers | `src/main/session/`, `src/main/goal.ts`, `src/main/agents.ts`; `src/shared/` |
| Browser bridge and companion extension | `src/main/{bridge,browser}.ts`; `extension/` |
| Desktop UI and native control | `src/renderer/`, `src/main/computer/`, `native/` |
| Build, packaging, releases | `scripts/`, `electron.vite.config.ts`, `electron-builder.yml`, `flake.nix`, `nix/package.nix`, `.github/workflows/` |

Keep these identities distinct when changing code: a local session can outlive and rebind its ChatGPT conversation; a local project does not grant filesystem permission; an approved root does. Browser actions need the exact conversation and document, queued input needs its exact outbox entry and delivery receipt, and workers belong to a particular prime run. An unknown owner must not be guessed when a tool, message, or file could reach the wrong conversation or project.

One durable fact should have one owner. Main-process code enforces permissions and records actual tool results; the extension owns browser observation and action; the renderer presents state through the fixed preload API. Async work must recheck its owner before publishing. A successful UI click or composer insertion is not a send receipt.

## Build and test

Use Node 24 and the committed npm lockfile. Run `npm ci` after a fresh clone or dependency change. On Linux and macOS, `nix develop` supplies the toolchain.

```sh
npm run dev                 # Electron development app
npm run typecheck
npm test -- test/name.test.ts
npm run verify              # privacy, notices, types, and full tests
npm run build
nix flake check             # bundle and Nix package checks
```

Run the nearest meaningful tests for a behavior change, including a case that should be rejected. Run `npm run verify` before a PR that changes production code or the build pipeline. Package on the target operating system and run its smoke test when changing the installed payload; [docs/build.md](docs/build.md) has the commands. Keep source, test, build, package, installed runtime, and live browser evidence separate in reports.

Do not point tests at an installed bridge or real user data. Follow `vitest.config.ts` and existing fixtures for isolated ports and temporary state. Never print credentials, private session content, or unredacted logs to diagnose a failure; see [SECURITY.md](SECURITY.md).

## Documentation and pull requests

Keep documentation useful to someone working with the current app. Update an existing guide when setup, a public tool, or a stable architecture boundary changes. Do not create dated worklogs, AI-generated audit files, investigation diaries, or files that repeat commit history. Put the change, reason, and actual validation in the PR description and commits. Add release notes only for a release, using the existing `docs/release-notes/` format.

Explain the final behavior in a PR, name the tests and runtime checks that passed, and state what could not be checked. Preserve contributors' authorship when incorporating outside work. Publishing and installed-app changes require their own explicit task scope; routine source edits do not imply them.
