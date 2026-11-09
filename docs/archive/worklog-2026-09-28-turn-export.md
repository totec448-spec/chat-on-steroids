# Copy and export completed answers

Base: `4e51a04`, branch `feat/turn-export`.

## Behaviour

- Under the answer of a turn the page reported as completed (`turn_end` with `completed`), two
  quiet actions: copy the answer, and export as Markdown with "This answer" or "Whole session".
  Open, partial and interrupted turns show nothing; the actions appear when a later `turn_end`
  completes the turn.
- Copy writes the answer's Markdown to the clipboard. Export opens a save dialog in Downloads,
  named after the chat, and reports the saved file name.
- The session transcript is the chat title, then your messages (the authored text, without
  transport-only instructions) and ChatGPT's final answers under `## You` / `## ChatGPT`: the
  latest revision of each message in its first place, without partial answers or Compact &
  Resume prompts.

## Design

- `src/shared/markdown-export.ts` selects messages and formats Markdown, so the renderer (where
  actions appear) and main (what is written) agree.
- `src/main/session/markdown-export.ts` reads the log and resolves answers cut in it through
  `readOverflowText`, so long answers copy and export whole; `sessions:exportMarkdown` validates
  the request. The timeline adds the actions to the anchored answer row and keys its signature
  on completion, so a row painted before `turn_end` is rebuilt with them.
- Icon `download-simple`; four new strings in all nine catalogs. The export menu is anchored to
  its button, flips at the window edge and uses the composer menus' motion.

## Validation

- New tests: message selection, completed turns, anchors, formatting and file names; main export
  (truncated answer read whole, save dialog and file, cancelled dialog, unfinished turn refused);
  renderer (actions only after completion, copy and session export requests, interrupted turn).
- Typecheck; IPC, preload, timeline, layout, HTML, i18n and icon font suites: 421 passed.
- Real Electron capture of the actions and the open export menu.
- The full suite was not run locally; relying on CI.
