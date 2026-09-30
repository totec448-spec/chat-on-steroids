<!-- CI checks this description. A PR that fails "PR checklist" or CI is not reviewed. See CONTRIBUTING.md. -->

Fixes #

## Why

<!-- The root cause, or the user problem this solves. -->

## What changed

<!-- The behavior change, in a few sentences. One topic per PR. -->

## Test

<!-- Name the test you added or changed and confirm it fails without your change.
     The "Fail-first test" check runs it against main's code to prove that.
     If a test is truly impossible, write: No test: <reason>
     If your tests only follow a refactor, write: Fail-first: n/a <reason> -->

Release note: <!-- Optional: one sentence for users, used to draft the release notes. Write "none" for changes users never notice. Leave it out and the PR title is used. -->

## Screenshots

<!-- Required when the interface changes: before and after, with placeholder data. Otherwise delete this section. -->

## Checklist

- [ ] `npm run verify` passes on my machine (OS: ).
- [ ] For interface changes: `npm run verify:ui` passes.
- [ ] The branch is up to date with `main`, and the PR contains nothing unrelated (no notes, logs or formatting-only changes).
- [ ] Screenshots, logs and examples contain no real names, paths, chat text, IDs or credentials.
- [ ] Every change serves the linked issue; nothing depends on ChatGPT's English wording.
- [ ] Contract changes (preload, IPC, `src/shared`, recorded fields, extension messages) are described in AGENTS.md, or I wrote "No contract change: <reason>".
- [ ] "Allow edits by maintainers" is on. If this builds on another PR, it says "Depends on #N" and is a draft.
