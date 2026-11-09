# Tool error-rate repair — 2026-08-24

## Scope

This is the evidence and implementation record for the three newest durable Chat On Steroids
sessions at 14:03 CEST on 24 August 2026. The sessions were still active, so these numbers are a
timestamped snapshot rather than a timeless product benchmark.

| Session | Role | Calls | Stored errors | Rejected | Stored error rate |
| --- | --- | ---: | ---: | ---: | ---: |
| `2026-08-24-8a3057a1` | prime | 97 | 10 | 1 | 10.31% |
| `2026-08-24-1013f77a` | worker-1 | 129 | 5 | 0 | 3.88% |
| `2026-08-24-5c7e9ab5` | worker-2 | 123 | 12 | 0 | 9.76% |
| **Combined** | | **349** | **27** | **1** | **7.74%** |

Including the rejected patch gives 28 unsuccessful interactions, or **8.02%**. All 27 stored
errors were `exec_command` non-zero exits: 27 errors among 161 exec calls, or **16.77%**.

## Exact classification

- 17 were real red/green validation events: failing regression tests or TypeScript checks while
  the agents were actively changing the implementation. The connector recorded those correctly.
- 5 were ripgrep patterns written with bash-style `\"` inside a PowerShell double-quoted
  argument. An even number of those quotes made the complete line look balanced to the existing
  repair guard, while PowerShell still parsed fragments as code or sent a corrupted regex to rg.
- 3 were relative path globs such as `test/computer*.test.ts` and `src/main/mcp/*.ts`. The
  existing normalizer expanded filename-only globs but deliberately refused every token holding
  `/` or `\`.
- 1 search named a nonexistent `tests` path alongside valid paths. Dropping that operand would
  hide an incomplete answer, so it remains a visible failure with recovery guidance.
- 1 quoted regex began with `--files` and was consequently interpreted as an rg option. Blindly
  converting unknown option-shaped tokens into patterns could hide real option typos; this also
  remains fail-closed.
- The separate `apply_patch` rejection used stale expected context. Patch matching was not
  loosened to make the metric look better.

## Implementation

`repairPowerShellQuoting` now handles a balanced command only when the affected bash-read string
is provably one whole argument in ripgrep's search-pattern slot. It reuses the pinned ripgrep
option tables to distinguish pattern, option-value and path positions. Arbitrary PowerShell
strings, path operands, interpolation, backticks, comments, here-strings, unknown options and
ambiguous token boundaries stay untouched. The former broader repair for a line PowerShell cannot
balance remains intact.

Relative path glob expansion now accepts one exact child directory beneath `exec_command`'s
resolved workdir. It lists only that directory's immediate entries, retains the caller's slash
spelling, quotes every expanded result, and keeps the existing 48-name bound. Absolute/drive/UNC
paths, `..`, wildcarded directory components, bracket classes, shell expansion, quoted globs and
unmatched globs remain unchanged.

The five quote failures and three path-glob failures are captured directly in
`test/exec-hints.test.ts`, with an end-to-end Windows regression in `test/mcp.test.ts` that runs
both forms through the actual Core tool and bundled ripgrep.

## Measured impact

The implemented predicates match exactly 8 of the 27 stored errors in this snapshot. If the same
calls are issued after a build/relaunch containing this source, the defensible corpus projection
is:

- stored errors: `27 / 349 = 7.74%` → `19 / 349 = 5.44%`;
- failed/rejected: `28 / 349 = 8.02%` → `20 / 349 = 5.73%`.

That is a projection against a frozen set of exact inputs, not a claim that live telemetry has
already changed. The currently running connector must be rebuilt/relaunched before a new session
can validate the production path.

## Verification

- `npm run typecheck`
- `npm test -- --run test/exec-hints.test.ts` — 88 passed
- `npm test -- --run test/codex-runtime-parity.test.ts` — 12 passed
- `npm test -- --run test/mcp.test.ts` — 142 passed
- `npm run verify` — 49 files passed; 1,397 tests passed, 1 skipped
- `npm run build` — main, preload and renderer production bundles built successfully
