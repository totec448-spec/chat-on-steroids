<!-- CI checks this description. A PR that fails "PR checklist" or CI is not reviewed. See CONTRIBUTING.md. -->

<!-- Optional: "Fixes #123" when this closes an issue. No issue is needed otherwise. -->

## Why

<!-- The root cause, or the user problem this solves. -->

## What changed

<!-- The behavior change, in a few sentences. One topic per PR. -->

## Edge cases

<!-- Required when code changes: the rare and edge cases this handles, and how. Think of empty or
     missing input, a restart or reload midway, two things happening at once, a slow or failed
     network, Windows and macOS, other languages, old saved data or an older extension.
     Name the tests that cover them where you can.
     If none apply (say, a wording change), write: No edge cases: <reason> -->

## Platforms

<!-- Required when the change touches the operating system (native helpers, windows and tray,
     keyboard shortcuts, the terminal and processes, dictation, secure storage, updates):
     how it behaves on Windows and on macOS, including keys the system or an input method
     takes first (Ctrl+Space switches the input source on many Macs). Trying it on a Mac is welcome
     but not required; then say why it works there. Otherwise delete this section. -->

## Saved data

<!-- Required when the change writes saved data (settings, files the app keeps, secure storage,
     extension storage): name the test that loads data saved by the previous version, and a
     damaged value. Otherwise delete this section. -->

## Test

<!-- Name the test you added or changed. The "Fail-first test" check runs it against main's code
     and proves it fails there, so you don't have to.
     New tests wait for a condition or use fake timers, never a fixed wait over a second
     (otherwise add a line: Long wait: <reason>).
     If a test is truly impossible, write: No test: <reason>
     If your tests only follow a refactor, write: Fail-first: n/a <reason> -->

Release note: <!-- Optional: one sentence for users, used to draft the release notes. Write "none" for changes users never notice. Leave it out and the PR title is used. -->

## Live proof

<!-- Required when the app or the extension behaves differently: show it working in the real app.
     A screenshot, a short recording, or an excerpt of the app log in a code block.
     Otherwise write: No behavior change: <reason> -->

## Screenshots

<!-- Required when the interface changes: before and after, with placeholder data. Otherwise delete this section. -->

<!-- A file over 500 KB (a picture, a binary) needs a line: Size: <reason> -->

## Checklist

- [ ] `npm run verify` passes on my machine (OS: ).
- [ ] For interface changes: `npm run verify:ui` passes.
- [ ] The branch is up to date with `main`, and the PR contains nothing unrelated (no notes, logs or formatting-only changes).
- [ ] Screenshots, logs and examples contain no real names, paths, chat text, IDs or credentials.
- [ ] Every change serves the linked issue; nothing depends on ChatGPT's English wording.
- [ ] Every new text a person sees is in all 12 languages, or there is none.
- [ ] Every decision the app makes (it waits, refuses, skips or retries) writes one log line saying which and why, or there is none.
- [ ] It sends no more to ChatGPT or other providers per step, or the PR says how much more and why.
- [ ] Contract changes (preload, IPC, `src/shared`, recorded fields, extension messages) are described in AGENTS.md, or I wrote "No contract change: <reason>".
- [ ] "Allow edits by maintainers" is on. If this builds on another PR, it says "Depends on #N" and is a draft.
