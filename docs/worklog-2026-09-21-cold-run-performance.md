# Cold first-run latency and private prompt presentation

## Reproduction and first wrong boundaries

- The captured cold run spent about 41 seconds between session-catalog readiness and restored
  multi-agent state. Startup awaited request-correlation recovery, which reopened bounded tails
  from up to 100 sessions even when the current correlation snapshot was valid.
- During a long final response, the presentation reveal rebuilt rich Markdown about 31 times per
  second. This was presentation work only; canonical recording already held the complete revision.
- A provider-rendered user row could temporarily lose its exact native source while retaining a
  normalized `COS_CONTEXT` header. The strict receipt source correctly refused that row, but the
  same refusal let private transport text become visible.

## Repair

- Correlation state version 6 marks a complete ledger. New exact owners cross an awaited durable
  snapshot before `/correlations` or `/events` can acknowledge them. Current complete snapshots
  therefore restore directly; older snapshots perform one history migration and publish v6 before
  startup admits traffic.
- The mandatory legacy migration still inspects canonical process-call evidence, but canonical
  shards now use eight bounded concurrent reads instead of thousands of serial Windows reads.
  Validation and map publication remain deterministic and at most eight shard reads run at once.
- Prompt display now quarantines a row that starts with the reserved transport header when exact
  source is temporarily unavailable. It shows a neutral pending glyph and never uses the hint as
  receipt, recording or acknowledgement authority. Exact framing still owns authored-text display.
- The transcript interval remains 250 ms for throttled/background receipt correctness. The
  one-second observer is only a silence watchdog when mutation-driven observation already ran.
- Visual text reveal paints at most 20 times per second, with a larger bounded character step;
  canonical text, backend publication and total reveal-speed policy are unchanged.
- Internal Chromium retains `backgroundThrottling: false`.

## Evidence

- `test/shell-compat.test.ts`: 94/94 passed, including both throttled background-worker receipt
  cases. A proposed 500 ms transcript debounce failed those cases and was removed.
- `npm run typecheck`: passed in mainstream and Internal Chromium.
- Shared changed source/test files: matching SHA-256 hashes in both repositories.
- `git diff --check`: passed in both repositories.
- A broader duplicated Vitest run was stopped because two repositories in parallel caused local
  resource pressure. It is not claimed as passing evidence.
