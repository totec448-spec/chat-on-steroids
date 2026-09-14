# Skills and model picker integration, 2.1.13

## Behavior

The initially empty library stores UTF-8 instruction files at `skills/<id>/SKILL.md` under application data. The composer offers **+ → Skills**, file import, search, removal and an action to open the managed directory. Leading slash completion selects installed skills, with `/prompt <id>` accepted as explicit syntax. Selection preserves the current draft and supports multiple distinct skills.

The existing first-message owner inserts Core instructions and a bounded skill index, complete selected skill bodies, optional project AGENTS.md and the complete authored request, in that order. The 96,000-character and UTF-8 transport budgets remain authoritative. AGENTS.md spends the remaining space; selected skill or user-text overflow fails explicitly. Prepared bytes stay in the existing input ledger through retry and restart. Explicit follow-up skills do not repeat Core setup.

The existing Core filesystem surface exposes `/skills` under normal capabilities. Canonical directory checks reject swapped roots and escaping links. Neither virtual skill paths nor native skill paths under overlapping approved home roots replace the learned project directory. No new MCP tool or automatically executed script is introduced.

## Model picker and retained fixes

The 2.1.12 picker patch is integrated. The signed-in browser's native menu was inspected with Desktop tools: its version list contains a retirement caption beneath the leading version label, and its retained React state supplies the exact model slugs, effort values, availability and version entries. This supports the patch's primary-label matching and metadata-based confirmation. Both ordinary input and worker bootstrap call the same `selectModelSettings` implementation. The picker code remains identical to 2.1.12; the separate logical-turn grouping change is retained.

Existing local repairs for request attribution, canonical-question recovery, Goal/Loop obligations, worker revival, continuation admission and terminal/plugin diagnostics are included. A bounded source review and test cross-reference found no concrete regression in these repairs. Existing tests already cover restored compaction pickup and expiry; no duplicate test was added.

Contributor attribution for the incorporated work from PRs #220, #224 and #227 is retained in CONTRIBUTORS.md and the integration commit.

## Verification

Focused checks cover storage and link handling, metadata refresh, selected prompt order, Unicode/character budgets, duplicate selections, unavailable skills, project workspace preservation, real input-ledger retries and renderer draft/keyboard behavior. The 43 model-picker regression cases pass against the integrated patch.

`node scripts/verify-skills-layout.cjs` uses the production renderer controller, HTML and CSS in an isolated Electron/Chromium process. Eight empty/populated layout cases cover 920- and 420-pixel viewports in both themes, with twelve screenshots inspected for fitting and readable controls. Import-to-Use and actual Chromium Enter/Tab events preserve authored text. This is a renderer fixture with API replies; it does not claim a live provider message was submitted.

The imported text and the managed filesystem path are covered by separate backend and delivery integration tests. No live chat messages or user skill installations were created for these checks.

The complete local `npm run verify` passed: 4,455 tests passed with 42 declared skips, followed by both isolated MCP shutdown tests. TypeScript, public-history privacy, dependency notices and pinned native-source validation passed. `npm run build` completed for main, preload and renderer. The only build messages were the existing mixed static/dynamic import chunk notices. `npm run verify:tunnel-current` confirmed the pinned tunnel client matches the current upstream release.
