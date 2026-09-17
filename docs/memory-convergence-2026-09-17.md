# Memory convergence — 2026-09-17

## Incident evidence

- A long-running Chat On Steroids 2.1.12 Electron renderer previously reached about 1.95 GiB private memory and 1.92 GiB working set, then returned to roughly 124 MiB private memory without restarting. This establishes a real transient renderer allocation spike; it does not identify the allocating subsystem.
- During the 2026-09-17 investigation the host reached 95.8% physical-RAM use with about 336 MiB free. One Chrome renderer held about 5.18 GiB private memory, 3.08 GiB working set, and nearly one CPU core. Chrome Task Manager did not label that renderer as any of the named visible live tabs. Ending only that renderer recovered the host to about 60.6% RAM use while the named live tabs remained present.
- The Chrome renderer incident is not attributed to CoS by this evidence. It is retained as a separate browser-memory observation, not as proof of an abandoned CoS tab.

## Change

- Added a bounded renderer-memory flight recorder. Ordinary samples remain in RAM. Threshold/large-step incidents persist only structural numeric/boolean diagnostics; authored text, transcript contents, ids, file names/paths, URLs, credentials, and image contents are not accepted by the IPC schema.
- Durable renderer snapshots are bounded by ring length, file count and file size, with threshold hysteresis and large-step cooldown.
- Added aggregate DOM/timeline/cache/tool/draft/attachment/data-URL pressure counters so a future Electron spike can be correlated with renderer structure without retaining user content.
- Added host physical-memory-aware browser retention. Normal settled app-owned pages retain the five-minute close window; at 20% or less free physical RAM, closure collapses to the existing two-minute reuse boundary. Existing exact document/epoch, draft, generation, selection, pin, pending-delivery and other protection checks remain authoritative.
- No process-kill policy and no Chrome-process attribution were added. A generic Chrome renderer cannot be safely terminated from CoS without stronger ownership proof.

## Validation

Run on `integration/cos-2.1.12-memory-convergence-r2-20260917` with the dependency tree from the lockfile-identical 2.1.12 integration worktree temporarily junctioned into this worktree, then removed.

- `vitest run test/renderer-memory-flight-recorder.test.ts test/preload-renderer-memory.test.ts test/renderer-state.test.ts --maxWorkers=1 --no-file-parallelism`: 45/45 passed.
- `npm run typecheck`: passed.
- `vitest run test/bridge.test.ts --maxWorkers=1 --no-file-parallelism`: 384/384 passed.
- `vitest run test/extension.test.ts --maxWorkers=1 --no-file-parallelism`: 155/155 passed.
- `npm run verify:privacy`: passed (public-history privacy check).
- `npm run build`: passed for main, preload and renderer bundles.
- `git diff --check`: passed.
- Validation was serialized because this host has 8 GiB physical RAM and the investigation itself demonstrated severe memory pressure. The broad default Vitest fan-out was not used as evidence for this slice.

## Remaining acceptance

- Source/test validation does not prove the installed app is running these bytes. Package/install/restart and live acceptance remain separate gates.
- After installation, verify that a future CoS renderer threshold incident writes a bounded privacy-safe snapshot and that pressure-driven idle-page closure never touches selected, pinned, drafted, generating, or pending-delivery pages.
- If another oversized Chrome renderer appears, capture its Chrome task ownership before termination. Do not infer that a generic renderer belongs to CoS solely from resource use.
