# Release sign-off — ChatGPT self-test

The last ChatGPT pass before this branch is proposed upstream. Paste everything below the line
into a ChatGPT conversation with the Core and Desktop connectors enabled.

**Setup that matters.** The connector must actually be picked in ChatGPT, not merely running. The
previous macOS round could not test the browser tool, sub-agents or blocked chats at all, because
every call arrived Unattributed — the app can only attribute a call to a conversation once the
extension has observed a real request id in a real ChatGPT turn. If the app's status still reads
"Pick the tunnel in ChatGPT", stop and fix that first; roughly a third of this document is
unreachable without it.

---

You are running the final release check on this app's tool surface. 80 steps. Nobody will answer
questions — decide for yourself and record what you decided.

After each step write one line: `N. PASS`, `N. FAIL — <exact evidence>`, or `N. SKIP — <reason>`.
Quote literal error text; a paraphrase is worth far less. Never report a step you did not run.

Only use the public test sites named here. Do not create accounts, enter real personal data, or
submit to any other site. Everything you create is temporary and you delete it in Mission 9.

## Mission 1 — identity and recording (1-8)

1. List every tool you can see, verbatim.
2. Run any trivial `exec_command`. Confirm from the reply that the call was **attributed** — no
   "unattributed activity" notice. If it is unattributed, say so and expect Missions 5-7 to fail.
3. Send three short messages in quick succession, each asking for a tool call. Then use `session`
   to read this conversation back and confirm all three user messages are recorded, in order,
   each with its own turn boundary.
4. `session` `action=search` with no query — the newest recordings.
5. `session` `action=search` for text you used in step 3, and confirm it finds *this* session.
6. `session` `action=read` on this session with a `T…` reference; confirm real arguments and result.
7. Save the `update_cursor`, run one more tool call, reuse the cursor, and confirm you get only
   the new activity rather than a replay.
8. Feed `session` a deliberately corrupted cursor. Confirm a clean, named refusal.

## Mission 2 — shell and files (9-22)

9. A command with real stdout.
10. One writing to stderr and exiting non-zero — confirm both text and true exit code.
11. The `cmds` array, three related commands, each with its own labeled section and exit code.
12. A `cmds` sequence where a middle command fails; later commands still run; overall code is the
    first non-zero.
13. A mistyped command — report the exact error and whether it is actionable.
14. Start a long-running process; capture its session id.
15. Poll it twice with `write_stdin` before it finishes.
16. Send it input containing a quote and an emoji; confirm exact round-trip.
17. Drain to its terminal exit code.
18. Reuse the finished session id — expect a clear refusal, not a hang.
19. `read` an ordinary file; then a large one, confirming an explicit continuation marker rather
    than silent truncation; then continue from the line it names with no gap or overlap.
20. `read` a binary file — expect a named refusal.
21. `read` a path outside the approved root — expect the refusal to name the boundary.
22. `apply_patch` a small edit, read it back to confirm exactly, then revert. Then try a patch
    whose context does not match and confirm the file is unchanged.

## Mission 3 — desktop (23-38)

23. `observe` bare: foreground window, screenshot, refs.
24. `observe what=windows`; pick a non-browser window.
25. `observe what=window` on it, then `what=ui`.
26. `focus` it and confirm by re-observing that it came forward.
27. `click_ref` a harmless control; verify by read-back that something changed.
28. Use a ref from a superseded snapshot — report whether it is honoured or refused, and which.
29. Use an invented ref — expect a named refusal that tells you what to do next.
30. Coordinate click with no `frameId` — expect `FRAME_REQUIRED`.
31. The same click with the correct `frameId`.
32. `move` the pointer, screenshot, and confirm the pointer is drawn where you moved it.
33. `type` into a focused field; verify by read-back.
34. `type` with nothing focused — record exactly what happens, refusal or acceptance.
35. `write_clipboard` then `read_clipboard`; confirm an exact round-trip.
36. Keys: a letter, a digit, `up` **and** `arrowup`, `f13`, punctuation `-` `[` `;` `\`, and a
    modifier chord. Report each.
37. An unknown key name — confirm the refusal **lists valid key names**.
38. `observe` once more. **The helper must still answer.** This is the crash check.

## Mission 4 — browser (39-52)

39. `navigate` to `https://the-internet.herokuapp.com/`.
40. `observe`; confirm refs and a screenshot.
41. `/dropdown` — select an option and verify by re-observing.
42. `/checkboxes` — read both states, toggle both, verify both flipped.
43. `/inputs` — type a number, then use arrow keys, confirm the value moved as expected.
44. `/login` — submit `tomsmith` / `SuperSecretPassword!` (the page's own documented demo
    credentials), confirm the secure area, then log out.
45. `/dynamic_loading/2` — start it and report how you told "loading" from "finished".
46. `/dynamic_controls` — enable the disabled input, then type into it.
47. `/hovers` — `move_ref` to reveal a caption without clicking.
48. `/horizontal_slider` — drag it and confirm the value changed.
49. `/iframe` — type into the editor inside the frame and read it back.
50. `/redirector` — follow it and confirm `status` reports the final URL.
51. `chrome://settings` and a `file://` URL — both refused by name.
52. `detach` and confirm the tab is released.

## Mission 5 — Goal and Loop (53-58)

53. Turn Goal on for this chat with a short real objective.
54. Let it draft and pick up once; confirm it typed something sensible.
55. Turn Goal off; confirm it stops nudging.
56. Turn Loop on; confirm Goal turns off — they are mutually exclusive.
57. Turn Loop off.
58. If no OpenRouter key is configured, SKIP 53-57 once and say so — the loop cannot draft
    without one.

## Mission 6 — Compact & Resume (59-66)

59. Push your context past the app's auto-compaction threshold with genuine large tool output.
60. Let the handoff happen. Confirm you land in a replacement chat with a real brief.
61. Confirm `session` shows one lineage across both chats (`chatIds` covers both).
62. Run a tool call in the new chat and confirm it works immediately.
63. **Note the landing time**, then do a few ordinary calls. If a second handoff fires within a
    couple of minutes with no real work behind it, report both timestamps — that is the loop this
    release fixed and this is its regression check.
64. If you can, compact again from the replacement chat (A→B→C) and confirm the lineage still
    reads correctly across both hops.
65. Read the earliest chat's history through `session` and confirm nothing was lost in the moves.
66. Confirm the retired chat refuses tools with a named reason rather than silently failing.

## Mission 7 — sub-agents (67-72)

67. If an `agents` tool is exposed, spawn one worker with a small real task.
68. Confirm the worker reports back and you can read its result.
69. Confirm both directions of the exchange appear in the recording.
70. Confirm a worker cannot reach outside the approved root.
71. Ask for a second worker while the first runs; report what happens.
72. If `agents` is not exposed, SKIP 67-71 once.

## Mission 8 — refusals worth having (73-77)

73. `read` a file that does not exist — exact error.
74. `read` a directory rather than a file — exact error.
75. `navigate` to a domain that does not resolve — clean error, no hang.
76. A browser action after `detach` — clean refusal.
77. A deliberately malformed argument to any tool — the validation error should name the field.

## Mission 9 — cleanup and verdict (78-80)

78. Delete every file you created; confirm by listing. Confirm no background process survives.
79. `detach` any driven tab; confirm the clipboard holds nothing from this test.
80. **Final report.**
    - A table of all 80 steps: number, PASS/FAIL/SKIP, one line.
    - Every FAIL restated with exact error text and what you were doing.
    - Anything that passed but felt slow, fragile or surprising.
    - Anything untestable, and precisely what was missing.
    - Your own judgement, plainly: which parts of this surface would you trust for unattended
      work, and which would you not? That sentence is the one being asked for.
