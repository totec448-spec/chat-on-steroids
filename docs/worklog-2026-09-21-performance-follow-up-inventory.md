# Runtime performance follow-up inventory — 2026-09-21

## Scope and evidence boundary

This inventory follows the cold-run, pet-overlay and sub-agent lifecycle repairs from the same
day. It separates remaining source-level cost from fixes already implemented. Code inspection,
Git provenance and the installed profile's redacted `app.log` support the findings below; they
are not a CPU profile of every listed path and do not prove that one path alone caused a whole-PC
stall.

## Already repaired in the pending change

- Request-correlation restore no longer scans up to 100 session histories when a complete v6
  snapshot exists. Older ledgers still migrate once from canonical evidence.
- The one-second content-script interval is now only a silence watchdog when the mutation-driven
  observer has already run.
- Assistant reveal paints at 20 Hz instead of about 31 Hz, without changing canonical content or
  backend delivery.
- The Pets overlay has no idle Windows/macOS cursor poll, keeps a shaped non-focusable interaction
  surface, avoids fullscreen prop layout roots and suppresses unchanged IPC projections.
- Sub-agent UI state comes from the broker lifecycle without a renderer poller or speculative tab
  cleanup.

## Confirmed remaining costs

### 1. Usage rebuild still runs automatically after startup

`src/main/index.ts` starts `usageOverview()` automatically after the shell loads. A changed or
invalidated cache row makes `src/main/session/usage.ts` call the full `readEvents()` path for that
session. That path flushes pending writes, reads the complete journal and canonical-message map,
then parses and projects the history.

The warmup was introduced by `6ee65e7`; cache version 9 in `62f940c` correctly invalidated older
derived rows but exposed the rebuild cost. The installed log contains these concrete runs:

| Time | Sessions | Rebuilt | Elapsed |
| --- | ---: | ---: | ---: |
| 2026-09-19 03:43 | 91 | 9 | 40,143 ms |
| 2026-09-20 15:01 | 90 | 90 | 20,349 ms |
| 2026-09-21 04:26 | 96 | 2 | 1,927 ms |

Elapsed time includes storage contention and awaited session queues; it is not proof of continuous
CPU use for the whole interval. Even so, full-history derivation is still admitted on the startup
hot path. The correct follow-up is to move rebuild work out of startup or make the recorder maintain
the required incremental facts. Adding another polling cache would create a second authority.

### 2. Live shell observation still performs bounded but substantial synchronous scans

The current MAIN helper limits each scan to six turns, 400 rows, 200 calls, 512 query-cache rows,
2,048 hook/memo candidates and a 4,096-node committed-child walk. These bounds are safety limits,
not a performance budget. The current alternate-shell paths (`shellLiveMapping`,
`shellCurrentPath`, `shellPublicActivity` and `committedPath`) arrived primarily through
`62f940c` and `2008124`.

During generation, transcript mutations remain coalesced at 250 ms and can request another Fiber
observation. Accepted changed assistant content then crosses the bridge and revises canonical
history. The pending watchdog repair removes redundant idle one-second scans; it does not reduce
the work of legitimate 250 ms observations or their synchronous React-tree traversal.

The existing shell-runtime verification proves ownership, bounds and timeout behavior, not CPU,
layout or IPC budgets. A follow-up needs per-scan timing/visited-node counters in an isolated
fixture and a real signed-in trace before changing evidence semantics.

### 3. Fake streaming still reparses and replaces the accumulated assistant response

`paintAssistantContent()` calls the rich Markdown pipeline for every reveal paint, replaces the
rendered subtree and reads geometry to preserve scroll position. Lowering the paint cadence to
20 Hz reduced frequency, but total work still grows with the revealed response. Canonical text
and backend publication are already complete and must remain untouched.

The next safe design target is a presentation-only incremental renderer or stable-prefix cache
that preserves citations, writing blocks, sanitization, copy actions and scroll anchoring. A mere
timer reduction trades stutter for latency and does not repair the scaling shape.

## Internal Chromium multiplier

This is not a recent host regression. The Internal branch's `internal-browser.ts` has retained
the same core behavior since its lab port: every hosted `WebContentsView` uses
`backgroundThrottling: false`; inactive tabs stay attached, visible and parked offscreen in at
least a 420×720 surface. That behavior preserves delivery and observation responsiveness, so
simply enabling throttling would risk missed or delayed turn state.

It does multiply the shared page costs above across a Prime and any live worker/helper tabs. The
future repair should separate execution/observation liveness from visual composition of parked
views, with a real multi-tab receipt/turn trace. It must not infer sleep from an offscreen tab or
hide a `WebContentsView` without proving that the provider still runs correctly.

## Measurement targets, not established regressions

- `extension/usage.js` clones and parses bounded SSE/WebSocket traffic (4 MiB and 2 MiB bounds).
  Most of this observer predates the compared baseline; it can multiply per live tab but has not
  been proved to cause the new stalls.
- The installed log contains 34 `ResizeObserver loop completed with undelivered notifications`
  reports. Four renderer owners exist (composer motion, Files, PDF preview and Terminal). Composer
  motion is a candidate because its animation changes the observed box, but the logs do not name
  the owner and do not prove a whole-system freeze.
- Canonical assistant revisions can produce IPC and atomic shard replacement during streaming.
  This is correctness-critical. Measure revision rate and write latency before considering
  coalescing, and never delay exact final, receipt or ownership publication.

## Ruled out by this audit

- No Electron or package dependency change was found between the earlier pet-performance baseline
  and this pending block.
- The Internal Chromium host implementation did not change in the recent upstream integrations.
- The retained swarm maintenance timer predates the observed regression and is not a new poller
  from the lifecycle-panel work.
- No evidence currently attributes the regression to a Chromium upgrade.
- The Pets full-host fixture passed with an advancing owner timer during hover, but an installed
  long-running provider/video run remains a separate evidence level.

## Installed Internal live run — 2026-09-21 02:04

An installed x64 Internal build was observed from process creation through a three-minute Prime
turn, two parallel workers, final response presentation and idle. CPU below is normalized across
12 logical processors; memory is summed working set. This is installed-payload evidence, not a
synthetic renderer fixture.

- Main started at about 02:04:58; renderer state was ready at 02:05:02.242 and the window reported
  loaded at 02:05:02.478. The catalog reused all 96 session summaries in 570 ms and Usage rebuilt
  none, so the cache path did not delay this startup.
- The first input was claimed in 162 ms and browser-acknowledged in 4,823 ms. The first tool call
  followed about 11 seconds after the recorded turn start.
- Spawning two workers added two renderer processes. Both reached exact `active`, executed tools,
  reported and transitioned to `sleeping`; the run then parked with no active worker. A later
  follow-up successfully reused worker-1 through `waking` and returned it to `sleeping`.
- Prime plus workers peaked at 34% CPU and about 1.7 GB working set. The worker renderers created
  for that run accumulated 38.5 and 28.3 CPU seconds. After tools and workers settled, final
  generation/reveal alone sustained about 14–18% CPU until the exact `turn_end`, then fell to
  3–4% within five seconds and 0–1% at idle.
- Idle retained seven renderers and about 1.0 GB working set because sleeping worker documents are
  kept for reuse, but no recurring Pet CPU burn was observed. No system-instruction leak marker,
  rejected tool, internal tool error or crash appeared. Two new-session metadata-projection
  warnings remain a separate correctness lead.
- Recorder publication cost was frequently 100–455 ms per request, sometimes exceeding a small
  read handler. It is measurable secondary overhead; the installed trace still points first to
  concurrent Chromium renderers and accumulated-response presentation.

This run upgrades the fake-stream and multi-view items above from source candidates to live
correlation. It does not distinguish provider-page generation from CoS response reveal inside
the aggregate renderer sample; the next trace must label WebContents before changing either.

## Prioritized follow-up

1. Instrument Usage rebuild phases and remove full-history rebuild from automatic startup.
2. Measure Fiber scan duration, visited candidates, observation frequency and canonical revision
   rate in one real long response with one tab, then with Prime plus workers in Internal Chromium.
3. Replace whole-response fake-stream repaint with an incremental presentation owner.
4. Attribute ResizeObserver warnings to their exact owner before changing layout code.
5. Only then evaluate parked-view composition in Internal Chromium while preserving background
   execution and exact receipt behavior.

## Validation of this pending block

- Mainstream focused protocol/UI suites: 1,131/1,131 passed.
- Typecheck and production builds passed in Mainstream and Internal Chromium.
- The built native Pets smoke passed in both repositories, including owner-timer progress during
  hover. One earlier Mainstream invocation captured a fully transparent frame alongside Chromium's
  `GPU state invalid` diagnostic; an immediate repeat and the Internal run passed. Treat the smoke
  as successful runtime coverage, but not as proof that first-frame GPU capture is deterministic.
- Pending path lists and per-file diff statistics match across both repositories. Files with
  fork-specific baselines retain their expected full-file hash differences; all other pending
  source, test and documentation files match byte-for-byte.
- `git diff --check` is required in both repositories immediately before the local commits.
