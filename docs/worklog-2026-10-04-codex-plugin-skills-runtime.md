# Codex plugin Skills runtime slice — 2026-10-04

Roadmap #482 / Refs #360.

## Scope

This slice exposes Skills contributed by installed and enabled Codex plugins through the existing
CoS Skills catalog. It does not add plugin installation, marketplace management, MCP bridging,
hooks, or another plugin UI.

Codex runtime state is authoritative. CoS runs the read-only `codex plugin list --json` command
with the same `CODEX_HOME`, validates its bounded JSON result, and carries plugin, marketplace,
version and source provenance into each projected Skill. The runtime-provided installed version
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

## Validation before current-main integration

- Focused Vitest: `test/codex-plugin-runtime.test.ts`, `test/skill-library.test.ts`,
  `test/skill-metadata.test.ts`, `test/renderer-skills.test.ts` — 24/24 passed.
- `npm run typecheck` — passed.
- `git diff --check` — passed.

Final validation is repeated after integrating the current upstream `main` before publication.
