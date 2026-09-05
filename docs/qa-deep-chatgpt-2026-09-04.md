# ChatGPT deep autonomous self-test — 2026-09-04 (post-v2.0.5 merge)

Paste everything below the line into a ChatGPT chat with the Core and Desktop connectors
enabled, on build 2.0.5+4dee53c or later. It runs start to finish with nobody answering
questions.

---

You are running a deep self-test of your own tool access on a build that just absorbed a
44-commit upstream merge. There are 60 numbered steps. Work them in order. After each step
write one line: `N. PASS`, `N. FAIL — <exact evidence>`, or `N. SKIP — <one-sentence reason>`.
Do not stop for confirmation; nobody is going to answer. Do not soften a failure into a maybe,
and never report a step you did not actually run. If a tool is not available to you at all, say
so once and SKIP its whole section rather than repeating the same line.

Keep a running note of anything surprising even where the step technically passed — you will
need it at the end.

## A. Discovery and basics (1-6)

1. List every tool you can actually see, by name. Report the list verbatim.
2. `exec_command`: run something with real stdout (e.g. print the working directory).
3. `exec_command`: run something that writes to stderr *and* exits non-zero on purpose.
   Confirm you get both the stderr text and the true exit code, not a generic failure.
4. `exec_command`: use the `cmds` array to run 2-3 related commands in one call. Confirm each
   gets its own labeled output section and its own exit code.
5. `exec_command`: run a command where a middle command in a `cmds` sequence fails. Confirm
   later commands still run and the overall exit code is the first non-zero one.
6. `exec_command`: deliberately mistype a command name. Report the exact error text you get
   back and whether it is actionable.

## B. Long-running and background work (7-11)

7. Start a longer-lived process that returns a session id.
8. Poll it with `write_stdin` at least twice *before* it finishes. Confirm polling returns
   incremental output rather than blocking.
9. Send it input through `write_stdin` and confirm the process actually received it.
10. Drain the session to its terminal exit. Report the final exit code.
11. Try to use a session id that has already terminated. Confirm you get a clear refusal, not a
    hang or a silent empty result.

## C. Files: read, find, apply_patch (12-19)

12. `read` an ordinary text file in your approved workspace.
13. `read` a large file (hundreds of lines). Confirm you get an explicit continuation marker
    naming the next line or a byte cap — not a silent truncation.
14. Continue that read from the line the marker named. Confirm you get the next chunk and no
    gap or overlap.
15. `read` a binary file if one is reachable. Confirm you get a named refusal identifying it as
    binary, not garbled bytes.
16. `read` a path deliberately *outside* any approved root (e.g. a system file). Confirm the
    refusal names the boundary rather than failing vaguely.
17. `find` for a filename pattern you know exists. Confirm the hits look right.
18. `find` for file *content* (a string you know is in a file). Confirm it locates it.
19. `apply_patch`: make a small, reversible edit to a scratch file you created in step 2-6,
    then read it back to confirm the edit landed exactly. Then revert it.

## D. Browser tool — the full surface (20-34)

20. `browser` `navigate` to a real site with a form (pick one; `selenium.dev`'s web-form page
    works well if you need a suggestion).
21. `browser` `observe`. Confirm you get refs for the page's controls.
22. `browser` screenshot. Confirm the image matches what `observe` described.
23. `click_ref` a button or link. Confirm the page reacted.
24. `type` into a text field by ref. Confirm the value landed.
25. `set_value` on a field that already has text. Confirm it *replaced* rather than appended.
26. `set_value` with an empty string. Confirm the field is emptied.
27. `move_ref` to hover a control. Confirm the reply says what it landed on and that it did not
    click.
28. `scroll` down. Confirm the reply reports it actually moved (`moved: true`), and that a
    follow-up screenshot shows the new position.
29. `drag` something, if the page has a draggable element or slider. Otherwise SKIP.
30. `double_click` something. Confirm it registered as a real double-click.
31. Open a second tab by clicking a link that targets one. Confirm `status` tracks it.
32. `back`, then `forward`. Confirm the document changes both ways.
33. Try to `navigate` to `chrome://settings`. Confirm a named refusal (expect
    `BROWSER_URL_REFUSED`), not a silent failure.
34. Try to `navigate` to a `file://` URL. Confirm the same. Then `detach` and confirm the tab is
    given back.

## E. Desktop: observe (35-40)

35. `observe` with no arguments. Confirm you get the foreground window, a screenshot, and
    snapshot-scoped UI controls with refs.
36. `observe` `what=windows`. Confirm you get a list of open windows with ids.
37. `observe` `what=window` on a specific window id from that list.
38. `observe` `what=ui` on that same window. Confirm the refs look usable.
39. Use a ref from an *old* snapshot (take a new `observe` first so the old one is superseded).
    Confirm you get a named staleness refusal (expect `STALE_UI_SNAPSHOT` or `UI_ELEMENT_GONE`)
    that tells you what to do next.
40. Use an obviously invalid ref. Confirm the refusal is clear rather than a crash.

## F. Desktop: computer — key map (41-48)

**This merge changed the key map directly, and a duplicate-key bug in it was found and fixed
just before this build. These steps are the single most valuable part of this test. If the
helper crashes, hangs, or dies on any keypress, report exactly which key and stop this section.**

41. `keypress` a plain letter and a digit.
42. `keypress` an arrow key using the short name (`up`).
43. `keypress` the same arrow using the DOM-style name (`arrowup`). Confirm both work.
44. `keypress` a function key beyond F12 (e.g. `f13`) if your platform accepts it.
45. `keypress` punctuation: try `-`, `[`, `;`, and a backslash. Report each individually.
46. `keypress` a modifier combo (e.g. `ctrl`+a style, or `command`+a on macOS).
47. `keypress` a deliberately unknown key name. Confirm you get a `BAD_KEY`-style refusal that
    *lists valid key names* rather than a bare error.
48. After all of the above, run one more `observe` to confirm the Desktop helper is still alive
    and answering. This is the real check for the crash bug that was just fixed.

## G. Desktop: computer — pointer, text, clipboard (49-55)

49. `click` by ref (`click_ref`) on a control from a fresh `observe`.
50. `click` by pixel coordinates. Note that this requires the `frameId` from the screenshot the
    coordinates came from — confirm that requirement is actually enforced if you omit it.
51. `move` the pointer, then screenshot and confirm the pointer is visibly drawn where you
    moved it.
52. `type` text into a focused field.
53. Try to `type` with nothing focused at all. Confirm a clean named refusal
    (`INPUT_TARGET_REQUIRED`/`INPUT_TARGET_LOST`-style), not a hang or a silent no-op.
54. `write_clipboard` some text, then `read_clipboard` and confirm it round-trips.
55. `focus` a specific window by id and confirm it actually came forward.

## H. Browser-chord refusal (56)

56. The `keypress` description now states that browser tab/window/address-bar chords are
    refused. Try one anyway against a Chrome window (a new-tab or address-bar chord). Confirm
    it is actually refused with a named reason — not silently accepted, not silently ignored.
    Report the exact refusal text.

## I. Session tool (57-59)

57. `session` `action=search` with no query. Confirm you get the newest recordings.
58. `session` `action=search` with a query matching something specific from earlier in this
    test (e.g. text you typed in step 24). Confirm it finds *this* session.
59. `session` `action=read` on this session, using a `T…` tool-call reference to expand one
    exact call. Confirm you see its real arguments and result. Then save the `update_cursor`
    it returns, do one more tool call, and reuse that cursor — confirm it returns only the new
    activity rather than replaying everything.

## J. Report (60)

60. Write the final report:
    - A table: step number, PASS/FAIL/SKIP, one-line note.
    - Then, separately: every FAIL restated with its exact error text and what you were doing.
    - Then: anything that passed but felt slow, fragile, or surprising.
    - Then: anything you could not test and what would be needed to test it.
    Be specific and literal. Exact error strings are worth far more than descriptions of them.
