# Public interim messages discarded by the classic reader

## Reproduction and cause

A signed-in GPT-5.6 Sol Extra High conversation contained eleven public commentary
preambles. The recorder retained the first four, with the fourth paragraph incomplete;
later tool activity and the final answer continued to arrive. Read-only inspection of
the mounted native turn showed that the fourth and subsequent preambles carried
`is_visually_hidden_from_conversation: true`, alongside the explicit public preamble
marker `is_thinking_preamble_message: true`. All were assistant/all text messages on
the commentary channel. A baseline MAIN helper scan returned only the first three
preambles and the final answer after the fourth acquired the presentation flag.

`authoredAssistantMessages` in `extension/fiber.js` rejected every message for which
`hiddenMessage` returned true. The presentation flag therefore stopped an already
recorded paragraph from growing and discarded later public updates. Both the source
reader and the older installed extension copy contained this predicate.

## Change

Keep explicitly marked assistant/all commentary text preambles despite
`is_visually_hidden_from_conversation`. The separate `is_visually_hidden` flag,
analysis, thought payloads, tool routing, and unmarked hidden text remain excluded.
Existing identity, ordering, text budgets, recording and terminal rules are unchanged.
The MAIN descriptor shape remains version 19.

## Validation

- Added one regression covering a presentation-flag change during streaming, complete
  text, later hidden preambles, tool interleaving, stable identity and a fresh scan.
  It failed before the production change, returning only the final answer.
- Eight neighboring exclusion cases passed before and after the change.
- All 134 tests in `test/fiber.test.ts` passed.
- All 1,126 tests in the extension, content-script, session and chronology suites passed.
- `npm run verify` exited 0: 5,724 main tests and 6 isolated shutdown tests passed;
  46 tests were skipped. `git diff --check` passed.

## Live outcome and scope

Chrome used the unpacked source extension. The affected finished conversation was
reloaded, and the companion was subsequently reloaded through Chrome's normal
extension management control. A new companion browser connection was observed and
the target conversation was loaded again.

All eleven public interim paragraphs, including the previously truncated fourth,
were visible in the companion's Chrome transcript. Opening the same conversation in
the installed CoS app independently showed all eleven paragraphs in their original
order between the relevant tool rows and before the final answer.

The live conclusion is based on the visible Chrome and native app transcript. An
additional post-change disk inspection and a post-extension-reload internal helper
count were blocked by the tool safety check and were not retried through another
route. No new provider generation was started for this acceptance check; the streaming
transition is covered by the regression above.

This task did not package, install, commit or publish an app release, and did not edit
live session ledgers. Private conversation bodies and identifiers are not included
in the regression fixture or this report.
