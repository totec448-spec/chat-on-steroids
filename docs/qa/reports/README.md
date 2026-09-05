# Where QA reports go

Drop reports in this folder and commit them. Any Claude session that opens the repository will
find them here, which is what makes them actionable rather than something to re-paste.

Name them by date and source:

```
2026-08-31-chatgpt-desktop.md      the 32-check run from docs/qa/chatgpt-desktop-qa-prompt.md
2026-08-31-claude-mac-automated.md the terminal output from docs/qa/claude-on-mac-start-here.md
```

Save them verbatim. Do not tidy the error messages, trim the noise, or summarise — an exact
error code is the difference between a fix and a guess, and the summarising has already been
done inside the report itself.

## What happens to them

Hand them to a Claude session **on the Mac**, not on another machine. Say which files to read and
ask it to work through the failures. The reason for the Mac is that most findings here can only
be re-checked where they were found; a fix verified anywhere else is a fix believed, not proven.

Two kinds of finding come out of these runs, and they are handled differently.

**A failure that reproduces on the Mac** — anything about the pointer, TCC permissions, window
resolution, or the onboarding step. Fix it there, verify it there, and say in the commit what was
observed rather than what was reasoned.

**A failure with nothing macOS-specific about it** — a wrong error message, a bad tool
description, a logic bug in the shared code. Those can be fixed on any machine and covered by a
test in `verify:ci`.

## The thing to watch for

A report that says everything passed is worth a second look before it is believed, particularly
on the pointer checks. The pointer has already been declared fixed once on the strength of code
that read correctly, and it was not fixed. The four direct questions at the end of the ChatGPT
prompt exist for that reason: if a report answers them vaguely, or answers them by describing
the code rather than the picture, it has not actually tested them.

Likewise, two checks in that prompt pass only by being **refused** — driving the tab holding the
conversation, and `file://` or `chrome://` URLs. A report listing those as failures has
misread them; they are the security properties working.
