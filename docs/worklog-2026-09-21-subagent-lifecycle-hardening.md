# Sub-agent lifecycle projection — 2026-09-21

## First wrong boundary

The Sub-agents panel received only recorded worker sessions and independently inferred whether
each row was active. A newly invited worker has no recorded session yet, and a bootstrap failure
may never acquire one, so both honest states could disappear from the panel. Reusable names such
as `worker-1` were also insufficient to select one family after several Prime chats had run.

## Repair

- The broker now exposes a read-only projection selected by the durable Prime conversation IDs
  belonging to one local session. It includes active and parked families without reactivating
  either and excludes unpublished staged runs.
- The session-scoped IPC resolves the selected session in main, including its current frontend
  for legacy metadata, before asking the broker for that projection. The renderer cannot select
  another family by a reusable worker label.
- The panel uses broker lifecycle as its sole state authority. Recorded sessions only add an
  available transcript. Workers without a transcript remain visible as non-clickable status rows
  with their task and any terminal reason.
- Lifecycle reads occur only when the selected session changes or the broker publishes a change.
  A generation fence prevents a late result from repainting a newly selected session; no polling
  was added.
- Ambiguous bootstrap timeout does not close or navigate a browser tab. Existing explicit browser
  evidence remains the only authority for browser cleanup.

## Validation

- `npm run typecheck`: passed.
- Focused renderer, broker and IPC suites: 291/291 passed.
- The broad verify run passed 5,870 tests and exposed two unrelated timing failures in terminal
  output and timeline-follow fixtures; both failed cases passed together when repeated alone.
- Production builds passed in mainstream and Internal Chromium.
- Regression coverage proves an unrecorded invited worker appears as `Starting`, a failed worker
  remains visible after its run parks, and an unrelated local session cannot see that family.
- `git diff --check`: passed.
- Impeccable detection reported one pre-existing side-border warning outside this change; no new
  lifecycle-panel finding was reported.
