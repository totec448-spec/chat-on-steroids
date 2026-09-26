# Lab port integrity audit — 2026-09-19

## Question and scope

This audit answers whether the user-authored delta from the frozen lab survived the split into
`Chat-on-steroids-mainstream` and `Chat-on-steroids-internal-chromium`. It covers the whole
delta, not only the View menu: Internal Chromium and its native host, Connection Advanced, Pets,
the shared Phosphor icon conversion, Skills/import/updater, Workspace/Usage/Settings/Setup UI,
composer modes and pills, and shell panel motion.

The immutable comparison points are:

- upstream starting point: `2f9acf307189ed1f05bee0cdc97871fdcff1d8f5`;
- approved frozen lab: `archive/port-fork-delta-2026-09-18` / `9e4ca8a`;
- pre-repair mainstream head: `71bda55`;
- pre-repair Internal head: `2c24751`.

The verified repaired trees are the subsequent native-View/parity and Internal provenance commits
that carry this report. The pre-repair hashes remain the stable comparison boundary.

This is source, unit/integration, build and isolated real-Electron evidence. It is not packaged
installer or signed-in provider acceptance.

## Result

The split was **not intact before this audit**. It lost two pieces of production behavior and two
pieces of acceptance coverage:

1. Internal's View renderer remained on its pre-Phosphor form because the shared Pets/icon commit
   was replayed where Internal-only files did not yet exist.
2. A mainstream-only cleanup of Connection Advanced was later merged into Internal and removed
   the adapter that treats the active Internal Chromium tab as the browser host.
3. `test/internal-browser-renderer.test.ts` did not cross the split.
4. The Agents & automation Chromium verifier lost its assertion that the selected settings surface
   uses the same subtle entry animation as the library pages.

Those losses are repaired. The current Internal View renderer and recovered motion test hash
byte-for-byte to the frozen lab; the View host additionally waits for its icon font and two
compositor frames before becoming visible. Connection Advanced again queries the optional Internal browser
host in parallel with companion diagnostics, scopes recorder data to the matching hosted tab and
keeps a live-host/pending-recorder state distinct from external companion state. Mainstream retains
the external-browser diagnostic path and contains no Internal browser command or production API.

## Structural proof

The lab range contains 16 authored commits. Their replay/evolution map is:

| Lab commit | Current lineage | Audit result |
| --- | --- | --- |
| `43c7b59` Internal Chromium/View | `bb404a0` | Core host files retained; thin legacy pet hunk superseded by the overlay owner. |
| `1338796` dock chrome | `41cf80a` | Same path and behavior. |
| `57d7687` resize affordance | `a4fc4f5` | Same path and behavior. |
| `8201ea8` active checks | `b962e98` | Same paths; Phosphor renderer restored. |
| `8ece266` trigger close | `29f6bf2` | Same paths and boundary. |
| `1980196` input close | `4cc7849` | Same paths and boundary. |
| `1607de5` Connection Advanced | `3a79544` | Shared UI retained; Internal host adapter restored after later removal. |
| `1997d50` connection polish | `e83e701` | Same nine paths. |
| `bb5fae6` Pets/icons | `73c889c` + `d398318` | Overlay/library retained; deadline scheduler is the mainstream performance evolution; Internal-only View hunks restored. |
| `495703b` Pets UI | `6a6a6ca` | Same eight paths. |
| `8925a9a` Skills/Workspace | `c37a9f6` | Same feature paths; Internal keeps the non-blocking prewarm change in its startup owner. |
| `4203882` GitHub Skills/updater | `77a9c4d` | Feature retained; missing visual assertion restored. |
| `c877ef6` Usage UI | `360938b` | Same six paths. |
| `90ae4b9` Settings/Setup | `53556fd` | Same twenty paths. |
| `bcea432` setup width/chevrons | `26573eb` | Same fourteen paths. |
| `9e4ca8a` panel motion | `c6a4fff` + `9912f58` | Shared motion retained; Internal dock integration and missing renderer test restored. |

Across the full `2f9acf3..9e4ca8a` delta:

- 114 paths were touched.
- 4 paths were intentionally deleted by the lab itself.
- All 110 paths present in the final lab exist in the current Internal tree.
- 78 are byte-for-byte equal to the final lab.
- 32 have later changes; their histories resolve to upstream integrations, the Internal replay,
  the Pets deadline scheduler, later UI fixes, translations/tests/worklogs, or the repairs above.
- 0 final-lab paths are missing.
- All 80 test declarations added by the lab delta are present in the current active tree.
- Frozen-lab hashes exactly match current Internal for the main/shared/renderer Internal browser
  owners, View preload/shared/renderer owners and the restored renderer-motion test. The View main
  owner retains the lab behavior plus the explicit font/compositor readiness barrier above.

The mainstream production tree has no Internal Chromium owner, dock IPC or browser-host handler.
The only `internalBrowser` references there are negative tests/fixtures proving that absence.

## Cross-repository repair parity

The audit repairs are paired by contract, not by blindly copying Internal-only behavior into
mainstream:

- the Agents & automation and compact Connection verifiers are byte-for-byte equal;
- panel-motion uses the same frame-sampling algorithm, with Internal's fourth browser track as
  its only behavioral extension;
- View uses the same native host lifecycle, font readiness barrier, Phosphor action glyphs,
  click/blur protection and renderer projection tests in both trees;
- mainstream intentionally exposes five commands with Pets first; Internal intentionally adds
  the ChatGPT browser command, brand mark, checked state and taller six-row surface;
- Connection Advanced keeps companion-only host projection in mainstream and adds the active
  app-owned tab adapter only in Internal;
- the Internal-only browser renderer test remains Internal-only, while both trees now exercise
  their View renderer through the narrow preload.

After this pairing pass, both trees passed typecheck, their focused View tests, real-Electron View,
Agents & automation, compact Connection and panel-motion verifiers. These results close the
source/test/isolated-Electron objective of this audit. They do not promote it to installer or
signed-in provider acceptance.

## Runtime and UI evidence

Focused suites:

- Mainstream authored features: 22 files, 246 tests passed.
- Internal authored features: 23 files, 257 tests passed.
- Internal browser ownership boundary (host, startup, bridge, IPC, input delivery, extension and
  browser): 10 files, 1,070 tests passed.
- The restored Connection/Internal regression passed with companion diagnostics absent, proving
  that the active hosted tab and conversation URL still project while recorder state is pending.
- Both projects typechecked and built; Electron/Vite emitted the View, Pets and main bundles.

Real Chromium/Electron verifiers passed for:

- mainstream View: five commands, Pets first, no browser row, exact Phosphor actions/checks;
- Internal View: six commands, ChatGPT brand mark plus exact Phosphor actions/checks;
- panel motion: three mainstream directions and four Internal directions, including intermediate
  geometry sampled inside Chromium;
- Workspace, Usage, Skills, Setup, Appearance and Agents & automation layouts;
- Pets overlay: 160×160 surface, 1280×1920 atlas, Tasks card, drag persistence, titlebar drag and
  pet-click owner-focus restoration;
- Pets performance: authored deadline wakes and zero RAF clock while hidden/reduced-motion;
- connection overlay hit testing and compact/Advanced geometry (160 px closed, 340 px open).

The old connection verifier expected 160 px even when Advanced was open although the frozen lab
CSS already specified 340 px. Its expectation was corrected in both active projects. The old
panel-motion verifier used a fixed 65 ms host sleep and intermittently missed the entire transition
under load; it now samples animation frames in Chromium and waits for the element transitions.

## Full-suite evidence and limitations

`npm run verify` reached all shared gates in both trees: packaged ripgrep checksum/staging,
public-history privacy, notices/native-source inventory and TypeScript all passed.

The final massively parallel Vitest phase exposed load-sensitive failures:

- mainstream: 5,347 passed, 44 skipped, four failed under contention;
- Internal: 5,337 passed, 44 skipped, six failed under contention.

Every reported failed case passed immediately in isolation. The separate six-test
`mcp-shutdown` gate passed in both projects. These are recorded as suite-load/desktop-state
flakes, not counted as a green one-shot `npm run verify`.

One unrelated shared visual verifier, `verify-settings-focus.cjs`, still observes a 30-pixel
native-select border repaint at zoom 1.17 after closing the picker in both projects. Geometry is
unchanged and the result is identical across the split, so it is not evidence of a lost port; it
remains a shared Chromium/settings acceptance debt.

Commit and push are delivery actions, not additional evidence levels. No installer build,
installation or signed-in ChatGPT acceptance is claimed by this audit.
