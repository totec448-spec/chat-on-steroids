# Direct assistant presentation — 2026-09-22

## Decision and boundary

The user chose to remove the artificial assistant text reveal from both forks. The renderer now
paints each complete canonical assistant revision as it arrives. The recorder, outbox, native
delivery and turn lifecycle remain unchanged; no local timer or presentation backlog can make a
finished backend turn look active.

The confirmed-input thinking dots remain visible only until real assistant content, tool activity,
an error or their existing timeout. Copy belongs to the last canonical final assistant message
only after its exact recorded turn ends; a reopened turn hides it again, and an unowned legacy
final does not borrow another turn's completion. Stop belongs to an active turn or pending input,
not to a completed turn. The Working/Worked rail uses the recorded turn end for its final
duration and retains the existing visual animation and short work phrases. Live-tail and reader
scroll ownership are preserved when canonical message revisions replace Markdown content.

Removed `src/renderer/text-reveal.ts` and the presentation-only `finish-presentation` action.
No backend, extension or provider behavior changed.

## Validation

- Mainstream: `npm run typecheck`, `npm run build`, and the complete
  `test/renderer-timeline.test.ts` suite passed (207/207).
- Internal Chromium: `npm run typecheck`, `npm run build`, and seven focused timeline cases
  covering direct presentation, pending feedback, scrolling, Stop and duration passed (4 + 3).
- `git diff --check` passed in both trees. The changed-line patches for `chat.ts`, its timeline
  tests, `AGENTS.md` and the removed reveal module match across both forks.
- The Impeccable mechanical detector reported no findings for `src/renderer/chat.ts`.

The follow-up Copy-boundary fix passed six focused timeline cases in each fork: final-before-end,
late tools and a second final, reopening, missing ownership, projected ownership and a still-active
exact control. Typecheck also passed in both trees after that fix.

The upstream merge is now present locally in both forks. New assistant blocks use one 140 ms
opacity-only entrance on live insertion; canonical text revisions remain immediate and the
reduced-motion stylesheet disables the effect.

These checks cover source behavior, not installed-app visual acceptance. The upstream merge is
local in both forks; publication and installed-app acceptance remain separate work.

## Follow-up locale and merge audit

Restored French and Turkish test coverage against the union of the other locale catalogs,
instead of comparing only those two incomplete catalogs. Added 148 shared translations in
both forks; Internal Chromium has eight additional browser-specific translations in each
catalog. Both forks passed the French/Turkish suites (7/7), seven focused timeline cases,
typecheck, build and `git diff --check`. No installer or live UI smoke was run.
The first mainstream `npm run verify` attempt was stopped after a concurrent
`exec-hints` pipeline failure; that exact case passed alone (1/1). A complete retry exposed
a reproducible timeline scroll regression (5930 passed, one failed). Direct canonical text
painting occurred before viewport restoration, which rewound the elected live tail. The
renderer now follows that tail after reconciliation while preserving reader scroll-away;
the formerly failing case passed alone in both forks.

After that repair, the mainstream full run reached its broad-suite summary (5930 passed,
one failed): an MCP process-session timing assertion received the initial running-process
chunk instead of the expected echo. It passed alone with one worker (1/1). The two final
suites skipped by the failed `&&` step passed when run separately (26/26). Thus mainstream
`npm run verify` is not green as one command, despite the passing isolated checks.
Internal Chromium `npm run verify` completed with exit code 0: broad suite 5917 passed,
46 skipped, followed by 26/26 final-suite tests. No installed-app smoke was performed.

## Canonical chunk fade follow-up

After approving a temporary 360 ms visual experiment outside the repositories, the user asked
for its initial entrance and per-chunk fade in the actual app. Both forks now paint each full
canonical Markdown revision immediately, while an opacity-only 360 ms animation applies to the
first live response and to newly appended visible text. On a later revision the initial-entry
class is removed, so the entire response does not fade again. Rewritten/non-append revisions,
historical rows, OS reduced-motion requests, and append bursts above 2,048 visible characters
paint without chunk animation. This is presentation only: no text reveal timer, queue, turn
status, Copy or Stop behavior was changed.

The focused timeline cases passed 4/4 in each fork after the final class fix, including direct
canonical projection, initial/chunk boundaries, reduced motion and live-tail behavior. Typecheck,
build and `git diff --check` passed in both forks. The two implementation patches and timeline
test patch match across forks; the stylesheet itself differs elsewhere because Internal Chromium
has its separate browser UI.

The mainstream broad verify run reported 5,931 passing, one failing unrelated completed-process
result case and 46 skipped; its exact failure passed alone, and the final 26 tests passed
separately. The Internal Chromium broad verify run exposed a separate rapid-New-Chat test failure
under load, which passed alone. Neither broad run is claimed green as one command. No installed
app visual check or installer build was run for this follow-up.
