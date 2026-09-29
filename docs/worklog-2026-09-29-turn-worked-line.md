# Worked line at the top of each exchange

Base: `5376974`, branch `feat/turn-worked-line`. Renderer only. First of a series of timeline
improvements.

## Behaviour

- Right after each of your messages, a quiet line on a hairline opens its work, as Codex does:
  the latest shows the live caption while the chat works ("Working for 12s", ticking, with a slow
  sheen through the words); earlier ones show "Worked for 1m 12s". Nothing folds.
- The header no longer repeats the caption outside developer mode; developer mode keeps its detail.
- While your message is still in the outbox, the live line waits right after it, so the line is
  born where the work begins instead of appearing elsewhere and moving.

## Why anchor to your messages

A first version anchored lines to ChatGPT's turn ids. A live session showed the page reporting
an empty turn (start and end back to back) right after a message, with every row of the real work
arriving with no turn id: the line landed mid-turn while working, then vanished. Lines now anchor
to your messages; a duration runs from the message to the last completed turn end or final answer
before your next message. On that session's data every message gets a line (39s, 19s, 17s, 21s,
43s).

## Validation

- Timeline suite: 213 passed, with cases for completed and earlier exchanges, the running turn at
  its top, a just-started turn after the outbox, and the empty-turn/untagged-work session shape.
- Layout, HTML, i18n and export suites: 120 passed. Electron captures of the line, the sheen
  frames and placement between the message and the turn's activity.
- The full suite was not run locally; relying on CI.
