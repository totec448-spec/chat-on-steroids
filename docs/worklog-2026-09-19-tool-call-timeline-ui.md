# Tool-call timeline spacing and line-delta colors

The recorded tool-call summary already occupied the transcript column, but its hover
surface had no horizontal padding. The icon/title and right-aligned metric sat at its
edges. Edit metrics also rendered `+N −N` as one green text node, so removed lines
inherited the success color.

The tool-call surface now extends 10 px beyond the text column on both sides while
keeping its content aligned with neighboring transcript rows. The renderer splits only
line-delta metrics into added and removed spans, using the existing green/red tokens.
Other metrics remain unchanged. Expanded per-file deltas use the same projection;
localized approximate labels are appended after the numeric spans.

Validation on both mainstream and Internal Chromium:

- `test/renderer-timeline.test.ts`: 190/190 passed before the final localization
  refinement; its new line-delta case passed again afterward in each repository.
- `scripts/verify-chat-width.cjs`: passed at 500/760/1100 px and zoom 1/1.17/1.5,
  including tool-row bleed, inner spacing and computed metric colors.
- Final `npm run typecheck` and `npm run build`: passed in both repositories.
- Full `npm run verify` was not green. Mainstream had 5,574 passing tests and one
  Windows window-capture failure; that exact case passed alone. Internal had 5,566
  passing tests and one PTY output-timing failure; that exact case passed alone.
  Neither failure points to the renderer files changed here.

No installer, installed profile, commit or remote repository was changed.
