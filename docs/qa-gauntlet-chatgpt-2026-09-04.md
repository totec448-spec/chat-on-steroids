# ChatGPT gauntlet — end-to-end workflow self-test, 2026-09-04

A harder companion to `qa-deep-chatgpt-2026-09-04.md`. That one sweeps the surface: call each
action, check each refusal. This one runs **realistic multi-tool work** — build a thing, research
it on the web, fill real forms, drive the desktop, verify every result by reading it back — which
is where integration bugs actually live. 112 steps.

Paste everything below the line into a ChatGPT chat with the Core and Desktop connectors enabled.

---

You are running an end-to-end gauntlet against this app's full tool surface. This is not a
checklist of isolated calls: most steps depend on the previous one, and the point is whether the
tools compose into real work. 112 steps. Nobody will answer questions — make the call yourself
and note what you decided.

After each step write one line: `N. PASS`, `N. FAIL — <exact evidence>`, or `N. SKIP — <reason>`.
Never report a step you did not actually run. Quote exact error text; a paraphrase is worth much
less than the literal string.

**Scope and safety.** Use only the public test sites named below — they exist to be automated
against. Do not create accounts on real services, do not enter real personal data, do not submit
anything to a site not listed here, and do not touch files outside your approved workspace root.
Everything you create is temporary and you will delete it in the final mission.

---

## Mission 1 — Build a small project from nothing (1-14)

1. `exec_command`: print your working directory and confirm it is inside an approved root.
2. Create a project directory `cos_gauntlet/` with subdirectories `src/`, `data/` and `out/`.
3. Write `src/tally.py`: reads a CSV on stdin, sums a numeric column, prints `TOTAL=<n>`. Write
   it with a heredoc through `exec_command`, not `apply_patch`.
4. `read` it back and confirm the content is byte-identical to what you wrote — no mangled
   quotes, no lost indentation.
5. Create `data/rows.csv` with a header and exactly 12 data rows, including one row whose text
   field contains a comma inside quotes and one containing an emoji.
6. Run the script against the CSV. Confirm `TOTAL=` matches what you compute independently.
7. Now break it deliberately: `apply_patch` a bug into `tally.py` (e.g. off-by-one on the row
   slice).
8. Run it again and confirm the output actually changed — proving the patch reached the file the
   interpreter loads.
9. `read` the file and confirm the patched line is exactly what you intended.
10. `apply_patch` the fix back. Run once more and confirm the original correct total returns.
11. `apply_patch` an edit whose context does **not** match the file (stale context on purpose).
    Confirm you get a clear refusal rather than a corrupted file.
12. `read` the file again and prove the failed patch changed nothing.
13. Write a file whose name contains a space and a unicode character. Read it back by that exact
    name.
14. Create a file with CRLF line endings and one with LF. Read both and report whether the tool
    distinguishes them or normalises silently.

## Mission 2 — Large data, budgets and streaming (15-24)

15. Generate a file of 5,000 lines where line N contains the text `LINE-N` plus padding.
16. `read` it with no range. Report the exact cap/continuation message you get.
17. Continue from the line the message named. Confirm the first line of the continuation is the
    one immediately after the last line of the first chunk — no gap, no repeat.
18. Continue until you reach line 5000. Report how many reads it took.
19. `read` a specific narrow range in the middle (e.g. lines 2500-2510). Confirm you get exactly
    those lines.
20. `read` a range whose start is past the end of the file. Confirm a sensible answer, not a
    crash.
21. Generate a 3 MB file. Try to read it whole. Report exactly what bounds you hit.
22. Use `exec_command` to extract just the lines matching a pattern, and confirm shell filtering
    reaches data the `read` budget alone would not.
23. Create a genuinely binary file (write raw bytes, e.g. via python). `read` it and confirm the
    named binary refusal.
24. Create a file that is *mostly* text but contains a single NUL byte. Read it and report how it
    is classified — this is the ambiguous case.

## Mission 3 — Background processes and interaction (25-33)

25. Start an interactive process that prompts for input and echoes it back (a small python REPL
    loop is ideal). Capture its session id.
26. Poll it before sending anything. Confirm you see its prompt.
27. Send it a line containing spaces and a quote character. Confirm it echoes back exactly.
28. Send it a line containing an emoji. Confirm the round-trip survives.
29. Send it a very long line (2,000+ characters). Confirm it is not truncated in transit.
30. Poll twice in a row with no input in between. Confirm the second poll does not duplicate the
    first poll's output.
31. Tell it to exit. Drain to the terminal exit code.
32. Start two background processes at once. Poll both, interleaved, and confirm their outputs
    never cross over into each other.
33. Start a process that writes continuously and let it run while you do the next mission's first
    three steps. Come back, poll it, and confirm it is still yours and still streaming.

## Mission 4 — Real browsing and research (34-48)

Use `https://the-internet.herokuapp.com` — a site built specifically to be automated against.

34. `browser` `navigate` to `https://the-internet.herokuapp.com/`.
35. `observe`. Confirm you get refs and a screenshot of the link index.
36. Navigate to `/dropdown`. Select an option using `set_value` or `click_ref`, and verify by
    re-observing that the selection actually changed.
37. Navigate to `/checkboxes`. Read the initial state of both checkboxes, toggle both, and verify
    both flipped.
38. Navigate to `/inputs`. Type a number, then use `keypress` arrow keys to increment it, and
    confirm the value changed by the amount you expect.
39. Navigate to `/login`. Submit deliberately **wrong** credentials and confirm the site's error
    banner appears (username `wrong`, password `wrong` — this is the site's own demo form, no
    real account exists).
40. Submit the credentials the page itself documents (`tomsmith` / `SuperSecretPassword!`) and
    confirm you reach the secure area. Then log out.
41. Navigate to `/dynamic_loading/2`. Start the load, and confirm you can tell "still loading"
    from "finished" — report how you determined it.
42. Navigate to `/dynamic_controls`. Enable the disabled input, then type into it. Confirm typing
    into it *before* enabling is either refused or visibly has no effect.
43. Navigate to `/hovers`. Use `move_ref` to hover a figure and confirm the caption appears
    without a click.
44. Navigate to `/horizontal_slider`. Drag the slider and confirm the displayed value changes.
45. Navigate to `/iframe`. Interact with the WYSIWYG editor inside the iframe — type text into it
    and read it back.
46. Navigate to `/nested_frames`. Report whether you can observe content inside the nested frames
    at all, and how it is presented.
47. Navigate to `/redirector`, follow the redirect, and confirm `status` reports the final URL
    rather than the starting one.
48. Navigate to `/status_codes/500`. Confirm the tool surfaces the page rather than treating a
    500 as a tool failure.

## Mission 5 — Forms, uploads and downloads (49-60)

49. Navigate to `/forgot_password`. Fill the email field with an obviously fake address
    (`gauntlet-test@example.invalid`) and submit. Report the result. `.invalid` is reserved by
    RFC 2606 precisely so it can never reach anyone.
50. Navigate to `https://www.selenium.dev/selenium/web/web-form.html`.
51. Fill **every** field on that form: text input, password, textarea, dropdown, datalist, file
    input if reachable, checkboxes, radios, colour, date, range.
52. Before submitting, `observe` and verify each field holds exactly what you set — list any that
    did not take.
53. Submit and confirm you reach the submitted page.
54. Go `back` and report whether the form retained its values.
55. Navigate to `/upload` on the-internet. Report whether a file input can be driven at all
    through this tool surface — if not, say exactly what is missing rather than calling it a
    failure.
56. Navigate to `/download`. Report whether initiating a download is possible and what happens.
57. Test `set_value` against a field that has an existing value, and confirm replace semantics.
58. Test typing into a field that enforces a `maxlength`, exceeding it. Confirm the tool reports
    what actually landed rather than what you sent.
59. Fill a field with a string containing `<script>` and quotes. Confirm it is handled as text
    and read back correctly.
60. Fill a field with a 1,000-character string. Confirm the full value landed.

## Mission 6 — Bringing the web back into files (61-68)

61. From any page you visited, extract a piece of visible text via `observe`.
62. Write that exact text into `data/scraped.txt` using `exec_command`.
63. `read` it back and confirm it matches character-for-character, including any punctuation or
    unicode.
64. Use `exec_command` with curl to fetch the same page's raw HTML.
65. Write a small script that extracts the same element from the raw HTML.
66. Compare the script's output to what `observe` reported. If they differ, say exactly how —
    this is a real signal about what `observe` normalises.
67. Take a browser screenshot (via `observe`) of a page, and use `view_image` on any image asset
    you can reach locally. Report whether image handling works end-to-end.
68. Build a small summary file listing every URL you visited in this mission with its final
    status. Read it back to verify.

## Mission 7 — Desktop, in earnest (69-84)

69. `observe` bare. Record the foreground window, frame id and snapshot id.
70. `observe what=windows`. Report how many windows and pick one that is *not* the browser.
71. `focus` that window and verify by re-observing that it actually came forward.
72. `observe what=ui` on it. Report how many controls came back.
73. Click a genuinely harmless control in it via `click_ref` (a menu that you then dismiss with
    Escape, for instance) and confirm the UI reacted.
74. Move the pointer to a specific coordinate and screenshot. Confirm the pointer is drawn there.
75. Do a coordinate click **without** passing `frameId`. Confirm the refusal.
76. Repeat it correctly with the `frameId` from the screenshot you just took.
77. Open a plain text editor (TextEdit on macOS / Notepad on Windows) via `exec_command`.
78. `observe` it, focus its text area, and `type` a paragraph containing punctuation and an emoji.
79. Screenshot and confirm visually that the text landed as typed.
80. Use `keypress` to select all, then use the clipboard: copy it, then `read_clipboard` and
    confirm the text matches what you typed.
81. `write_clipboard` a different string, paste it into the editor with a keypress, and confirm
    the editor now shows the new string.
82. Save the file to your workspace using the editor's own save dialog if you can drive it — if
    the dialog defeats you, say exactly where it defeated you.
83. Independently `read` the saved file and confirm its contents match what the editor showed.
84. Close the editor without saving further changes.

## Mission 8 — Interleaving and state (85-92)

85. With the editor still open earlier, you ran browser work in between — confirm the browser tab
    is still driven and `status` still reports it.
86. Alternate three times: one browser action, one desktop action, one file read. Confirm none
    interferes with the others.
87. Take a desktop screenshot, then a browser observe, then use the *desktop* frameId for a
    desktop click. Confirm the frames did not get confused.
88. Deliberately use a browser ref for a desktop action. Confirm a clean refusal, not a wrong
    click.
89. Deliberately use a desktop ref for a browser action. Confirm the same.
90. Run a long `exec_command` (5+ seconds) and, while it runs, confirm whether you can issue a
    browser action — report whether they serialise or run concurrently.
91. Check `session` mid-run: confirm your recent tool calls appear in this conversation's own
    recording.
92. Confirm the recording's tool-call count roughly matches how many calls you have made.

## Mission 9 — Errors, edges and recovery (93-102)

93. Ask `read` for a file that does not exist. Exact error text?
94. Ask `read` for a directory rather than a file. Exact error text?
95. `exec_command` a command that produces 200,000 characters of output. Report how it is bounded
    and whether the bound is stated.
96. `exec_command` something that writes to stdout and stderr simultaneously and interleaved.
    Report whether ordering is preserved.
97. `exec_command` a command that exits via signal rather than a normal exit code.
98. Try `apply_patch` on a file that does not exist. Exact error?
99. Try `apply_patch` creating a file outside the approved root. Confirm refusal names the
    boundary.
100. `browser navigate` to a domain that does not resolve. Confirm a clean error.
101. `browser` an action against a page after you have detached. Confirm a clean refusal.
102. Give a deliberately malformed argument to any tool (wrong type, unknown field). Confirm the
     validation error names the field.

## Mission 10 — Sub-agents, if available (103-106)

103. If an `agents` tool is exposed, spawn one worker with a small real task (e.g. count the lines
     in `data/rows.csv` and report back).
104. Confirm the worker reports a result and that you can read it.
105. Confirm the exchange appears in the session recording.
106. If `agents` is not exposed, SKIP all four and say so once.

## Mission 11 — Cleanup and honesty (107-112)

107. Delete every file and directory you created under `cos_gauntlet/`.
108. Confirm by listing that nothing you created remains.
109. Confirm no background process you started is still running.
110. `detach` the browser tab and confirm it is released.
111. Confirm the clipboard is not left holding anything sensitive from the test.
112. **Final report.** Produce:
     - A table of all 112 steps: number, PASS/FAIL/SKIP, one-line note.
     - Every FAIL restated with exact error text and what you were doing.
     - **The composition failures specifically**: any case where two tools each worked alone but
       failed together. These matter more than any single-tool bug.
     - Anything that passed but was slow, fragile, or surprising.
     - Anything you could not test, and precisely what was missing.
     - Your own honest judgement: which parts of this surface would you trust for unattended
       work, and which would you not?
