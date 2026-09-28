# Startup trusts the committed request-owner ledger — 2026-09-27

## Evidence and decision

An installed build opened noticeably slower than the maintainer's fork builds on the
same user data. Its log showed the session catalog ready quickly while the window was
still waiting behind `restoreRequestCorrelations()`, which runs before `app started`.

Version 5 wrote `state/request-correlations.json` as a debounced snapshot, while the
browser was told an owner was confirmed as soon as it was in memory. A crash inside that
300 ms window could leave the snapshot behind recorded history, so every launch replayed
recorded exact calls from the newest 100 sessions. Those reads open every canonical
message shard of each session. On Windows this is latency-bound and grows with history.

The crash window, not the replay, was the earliest wrong boundary. The fix closes it
and removes the need for the replay instead of making the replay faster or hiding it
behind an earlier window.

## Narrow implementation

- `recordRequestEvidence()` is the only path that stores a new owner. When a batch
  stores at least one, it awaits `commitRequestCorrelations()` (`writeDurableNow`)
  before returning. `/correlations` and `/events` acknowledge only after that, so the
  browser never retires evidence the ledger does not yet hold. Re-proving a known
  owner and refused claims write nothing.
- The ledger becomes version 6 with `complete: true`. Restore trusts it without
  reading session history only when every row is a readable owner. An unmarked,
  older or partly unreadable ledger keeps the existing bounded reconciliation once,
  then is written complete before bridge/MCP traffic starts.
- Canonical shard reads during that one migration run eight at a time. Validation,
  hash-name checks and insertion order are unchanged.
- First proof still wins, the session epoch is retained and the 50,000-entry bound
  is unchanged. `AGENTS.md` §4/§7 now describe the committed ledger.

Compatibility: a version 5 build ignores a version 6 file and rebuilds from its
100-session window, then writes version 5. The next version 6 launch migrates once.
Alternating builds therefore repeats one migration per switch; it does not lose
owners the history window can still prove.

## Regression evidence

Three regressions failed with the production change removed and pass with it:

- a newly proved owner is on disk, marked complete, immediately after
  `recordRequestEvidence()` returns and before any flush; re-proof does not rewrite it;
- a complete ledger does not replay history, while an unmarked ledger and one with
  an unreadable row do;
- migrating a stale version 5 snapshot rewrites a complete version 6 ledger with both
  the snapshot owner and the owner recovered from history.

The existing stale-snapshot test now writes its version 5 shape explicitly, so it
still exercises the migration path.

Checks run: `npm run typecheck`; Vitest `correlation`, `backend-recording`,
`attribution-repair`, `bridge`, `request-agent-ownership`, `shell-agent-roundtrip`,
`call-context`, `mcp-inflight`, `mcp`, `session`, `chronology` and `content-script`
(12 files, 1,740 passed, 6 skipped). The full suite is left to CI.

## Credit

Ported from Haz4rdovisk/chat-on-steroids-mainstream@e6755d9 (startup part only;
its extension first-turn changes are not included).
