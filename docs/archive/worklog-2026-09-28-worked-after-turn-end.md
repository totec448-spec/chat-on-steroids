# "Worked" as soon as a turn ends

Base: `4e51a04`, branch `fix/worked-after-turn-end`. Renderer only.

## Finding

A live session recorded its last tool call at 22:28:33.9, the page's
`turn_end` (completed) at 22:28:38.7 and the final answer at 22:28:59.7, yet the caption kept
saying "Working…" until about 22:30:04. The status caption falls back to "Working…" for ninety
seconds after the last recorded tool call (`BLIND_CAPTION_MS`), so chats whose page stops
reporting turns do not look idle. That fallback was checked before the finished turn and ignored
the reported end, so every normal turn stayed "Working…" for up to ninety seconds after it ended.
The sidebar already required the tool call to be newer than the last end.

## Change

The fallback applies only to a tool call newer than the last reported end (the turn end event,
`lastTurnEndAt` or `lastAssistantFinalAt`), the sidebar's rule. Tool calls after a reported end
still read as "Working…".

## Validation

- Timeline suite: 207 passed, including a new case for a turn whose end follows its last tool
  call ("Worked for 38s") and a tool call after that end ("Working…"); the existing blind-page
  case is unchanged.
- The full suite was not run locally; relying on CI.
