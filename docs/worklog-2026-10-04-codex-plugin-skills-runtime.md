# Codex plugin Skills runtime slice — 2026-10-04

Roadmap #482 / Refs #360.

## Scope

This slice exposes Skills contributed by installed and enabled Codex plugins through the existing
CoS Skills catalog. It does not add plugin installation, marketplace management, MCP bridging,
hooks, or another plugin UI.

Codex runtime state is authoritative. CoS runs the read-only `codex plugin list --json` command
with the same `CODEX_HOME`, validates its bounded JSON result, and carries plugin, marketplace,
version and safe source provenance into each projected Skill. Native local marketplace/source paths
are not sent to the renderer. The runtime-provided installed version
selects exactly `plugins/cache/<marketplace>/<plugin>/<version>`; CoS never chooses a version by
enumerating cache contents. Stale, disabled and unlisted cache entries therefore cannot become
active Skills.

The selected package remains subject to the existing Skills read capability and sandbox. Its
manifest identity is revalidated before scanning only that package's `skills/` directory. Command
identity uses marketplace, plugin and package-relative Skill path so a runtime-reported upgrade
does not rename the command.

## Upstream contract checked

Current `openai/codex` `codex-rs/cli/src/plugin_cmd.rs` defines `codex plugin list --json` as an
installed/available snapshot. Installed rows expose `pluginId`, `name`, `marketplaceName`,
`version`, `installed`, `enabled`, `source`, and configured marketplace provenance. The Codex
plugin store maps a plugin id and version to the same cache layout used here.

## Validation

- Current `upstream/main` was integrated at exact `9d1c033b15ed5603db7f690ed2aa1176ab4aa4a4`
  with a merge before final validation.
- Focused Vitest: `test/codex-plugin-runtime.test.ts`, `test/skill-library.test.ts`,
  `test/skill-metadata.test.ts`, `test/renderer-skills.test.ts` — 25/25 passed after final
  provenance hardening.
- `npm run typecheck` — passed.
- `git diff --check` — passed.
- `npm run verify:privacy` — passed.
- `npm run verify:notices` — passed.
- `npm run build` — passed.
- Full `npm run verify` reached 6,966 passed / 48 skipped with two Windows exec-session failures in
  `test/mcp.test.ts`. Both exact failing cases reproduce unchanged in a clean detached worktree at
  `9d1c033b15ed5603db7f690ed2aa1176ab4aa4a4`; neither test nor its implementation is in this diff.
