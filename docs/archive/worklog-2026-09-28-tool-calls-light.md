# Lighter, aligned tool calls

Base: `4e51a04`, branch `ui/tool-calls-light`. Renderer only.

## Findings

Measured in real Electron with a fixture that mirrors live sessions (runs of shell calls,
failures, refusals, reads, edits, plan updates and page activity):

- Commands and edits drew a bordered card-coloured capsule each (`.tool.is-artifact`) with an
  accent chip, so a run of shell calls read as a wall of boxes. An open call nested a bordered
  Arguments card and a bordered Result card inside that capsule.
- Page activity rows were 20px at 12px/520 and 76% opacity beside 29px tool rows at 12.5px/450,
  with their text 2px off the tool column; group headers were 14px.
- An edit's change count beside the title repeated the outcome metric on the right
  (`+2 −13` twice; `+39 −0` beside `+39`).
- `.tool.tone-bad { background: transparent }` dropped the open surface of failed calls, so
  their result wells disappeared into the page.

## Change

- Every call is the same quiet row: kind icon, a small tinted kind badge (`shell` in the accent,
  `diff` in green), title at 450 and a grey outcome. Only failures colour their icon and outcome.
- An open call (failed ones included) is one surface; arguments and result are recessed wells
  with Copy on hover. Message code blocks share `.tool-output` and are unchanged.
- Page activity shares the tool row's height, face, weight and icon column; group headers are
  13px. All rows measure 29px with the icon and text in one column.
- The count beside the title shows only when the outcome metric is not already a line delta.

## Validation

- Timeline, renderer HTML and layout suites: 277 passed, including a created-file case for the
  single count.
- Electron captures before/after on the fixture; failed calls open with their surface.
- The full suite was not run locally; relying on CI.
