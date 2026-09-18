# Overwrite native thinking/status notifications

## Change

The extension kept native thinking notifications visible in expanded activity and
recreated recorded `page_tool` captions in a closed activity fold. This produced
stacks of provider summaries alongside the actual recorded tool calls.

`nativeStatusRows()` now identifies current native thought notifications and plain
noninteractive status captions. The existing presentation pass suppresses them
whenever Overwrite is active, including when no local call has been recorded,
attributed or mounted. Native scan identity remains required; local recording is
not display authority for these captions. The closed-fold projection no longer
includes `page_tool` rows. Public assistant messages, tool details and native
results retain their existing rendering.

The existing DOM owner removes the full replaceable layout slot. It still restores
native rows on stale native scan identity, Overwrite Off and navigation. Native activity
recording and its use by recovery are unchanged.

## Verification

- Before the production change, four focused regression cases failed: unmounted,
  clipped and expanded activity folds, plus typed duplicate notifications without
  a recorded status copy.
- Four further regression cases demonstrated the old dependency on recorded or
  mounted calls. After removing that dependency, all 94 chronological-stream tests
  passed. These include native results and controls, row remounts, absent local
  recording/placement, foreign native identity, disclosure retention, Off
  restoration and navigation.
- The real Chromium layout fixture passes all 18 combinations of width, zoom and
  native fold state. It checks that a typed notification's complete layout slot
  has zero height and returns when Overwrite is disabled. The generated screenshot
  was visually inspected; it contains only synthetic content.
- The broad `npm run verify` attempt passed 5,218 tests and failed two native
  Windows UI Automation checks in `test/computer.test.ts`: an unavailable browser
  UI root and an absent snapshot id. Its privacy, license/source-notice and
  typecheck stages passed. The separate shutdown phase was not reached.
- Final affected-suite verification passed all 1,072 tests across
  `content-script`, `fiber`, `chatgpt-dom-input` and `extension`.
- Both failed Windows UI Automation checks passed when rerun separately, without
  changes to their implementation or tests. The original broad run remains a
  failed attempt; its result is not relabeled as a successful full run.
- All six tests in the separate `mcp-shutdown` suite passed.
- The final typecheck, public-history privacy check, production build and
  `git diff --check` passed. Build output contains existing mixed static/dynamic
  import warnings; these did not fail the build.

## Evidence boundary

The existing signed-in conversation was read through the browser snapshot tool.
The page had already reached its final answer. A DOM JavaScript inspection was
blocked by the tool safety check, and the exact browser tab was subsequently
reported closed. No replacement tab was opened. Synthetic test/layout results
do not establish installed-extension acceptance. No installation, commit or
publication was performed for this change.
