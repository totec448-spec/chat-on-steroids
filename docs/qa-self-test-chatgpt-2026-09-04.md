# ChatGPT autonomous self-test — 2026-09-04

Paste everything below the line into a ChatGPT chat with the Core and Desktop connectors
enabled. It is written to run start to finish without anyone typing anything back — where
earlier versions of this test needed a human to send messages, confirm something visually, or
click a switch, this one either finds a way to trigger the same fact through a tool call, or
explicitly skips the step and says why rather than guessing. Work through every section in
order; report pass/fail/skip after each one and keep going.

---

You are running a fully autonomous self-test of your own tool access in this app. Nobody is
going to answer follow-up questions, so don't ask any — if something can't be verified without a
human, mark that section SKIP (AUTONOMOUS LIMIT) with one sentence on what would need a person,
and move on. Don't fabricate a result for anything you didn't actually check.

**1. exec_command, in depth.** A command with real stdout and stderr. A command that exits
non-zero on purpose. A background/long-running process you poll via `write_stdin` at least twice
before it completes. The `cmds` array for 2-3 related commands in one call. A deliberately
mistyped command and note the exact shape of the error you get back — does it look like an
ordinary shell error, or something else intercepting it first?

**2. `read` vs `exec_command`, and read's own edges.** Read a real file normally from whatever
workspace root you have. Read a large file (hundreds of lines) and check whether you got an
explicit continuation marker rather than a silent truncation. If a binary file exists anywhere
reachable, read it and confirm you get a named refusal, not garbled output. Confirm you reach for
`read` rather than `cat`/`type` through exec_command for plain file reads.

**3. `browser`, in depth.** Navigate to a real site with a form (pick one). Screenshot, click,
type into a field, scroll, hover, and drag if there's a draggable element. Open a second tab from
a link and confirm it's tracked in status. Try `chrome://settings` and a `file://` URL and confirm
both are refused with a named reason. Navigate back and forward. Report the driver's own status
output (tab id, group id, build) rather than describing it vaguely.

**4. `computer`, in depth (if Desktop is enabled).** Screenshot the current screen. Click
something using the returned frame/coordinates. Try to act on a Chrome window with nothing
focused in it and confirm you get a clean, named refusal rather than a hang. Focus something in
Chrome first (its address bar is reliable) and confirm a second attempt then works.

**5. Session tool, all shapes.** `search` with no query. `search` with a query matching something
specific from earlier in this test (a command you ran, a URL you visited). `read` this session
with a `T…` tool-call reference to inspect one exact call. If enough activity has accumulated,
reuse an `update_cursor` from an earlier read and confirm it returns only new activity.

**6. Self-triggered Compact & Resume.** This is the one earlier versions of this test needed a
human to push along — you can do it yourself. Deliberately generate enough large tool output to
cross this app's auto-compaction threshold: read a genuinely large file in full, or take several
screenshots in a row, or both. Once a handoff actually happens and you land in the replacement
chat:
   - Confirm you got a real handoff brief, not an empty or malformed one.
   - Use `session` to confirm the old and new chat are one lineage (`chatIds` covers both) and
     that your own earlier activity (exec_command output, the file you read, etc.) is still
     reachable through it.
   - Run one ordinary tool call in the new chat and confirm it works normally.
   - **This is the important part.** Note the exact time the handoff landed, then keep working
     normally (a few ordinary tool calls, nothing designed to inflate tokens again). If a
     *second* handoff fires within a couple of minutes of landing in the replacement chat,
     before you've done anything to deserve one, say so explicitly with both timestamps — that
     is the loop pattern from an earlier QA pass, and if it's still happening, this is the
     clearest evidence anyone will get of it. If it doesn't happen, say that plainly too; a
     single, well-behaved compaction is a PASS, not evidence either way about the loop.
   - If nothing about your context makes this reachable (auto-compaction disabled, or the
     threshold is high enough that you can't realistically cross it), say so and mark this
     section SKIP with the reason — don't force it in a way that wastes the session.

**7. Multi-agent/swarm, if reachable.** If you have an `agents`-type tool or multi-agent is
otherwise available, spawn at least one worker with a small real task, have it report back, and
read the result. If the tool genuinely isn't exposed, say so once and move on — don't argue with
the environment about it.

**8. Report.** One line per section: PASS, FAIL (with the specific evidence), or SKIP
(AUTONOMOUS LIMIT, with the one-sentence reason). Then a short freeform note on anything that
felt slow, fragile, or worth a second look even where it technically passed. Be specific about
timestamps and exact error text wherever you have them — vague descriptions are much less useful
than the literal thing the tool returned.
