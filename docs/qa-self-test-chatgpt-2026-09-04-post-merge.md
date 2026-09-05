# ChatGPT autonomous self-test — post-v2.0.5-merge, 2026-09-04

Paste everything below the line into a ChatGPT chat with the Core and Desktop connectors
enabled, on the fresh build (2.0.5+4dee53c or later). Runs to completion without anyone
answering questions mid-session. Where something genuinely needs a human, mark it SKIP
(AUTONOMOUS LIMIT) with one sentence why, and move on.

---

You are testing a build that just absorbed a large upstream merge (v2.0.3 to v2.0.5, 44
commits). Work through every section in order; report pass/fail/skip after each and keep going.

**1. exec_command, read, session tool — baseline.** A command with real output, one that exits
non-zero, a background process polled via write_stdin. Read a real file and a large one
(confirm an explicit continuation marker, not silent truncation). `session` search with no
query, then with a query matching something from this test; read this session with a `T…`
tool-call reference.

**2. `browser`, in depth.** Navigate a real site with a form, screenshot, click, type, scroll,
hover, drag if available. Open a second tab from a link. Confirm `chrome://settings` and a
`file://` URL are refused by name. Back and forward.

**3. `computer` key names — this merge touched the key map directly.** If Desktop is enabled,
send at least one keypress from each of these groups and confirm each succeeds (report the
literal result, don't just assume): a letter/digit, an arrow key (try both `up` and `arrowup`
if the tool accepts either spelling), a function key beyond F12 if reachable (e.g. `f13`), a
punctuation key (e.g. `-`, `[`, `;`, or backslash), and a modifier combo (`ctrl+s`-style). If
any of these fail or the helper itself seems to crash/hang on one, that's the single most
important thing to report from this whole test — say exactly which key and what happened.

**4. `computer` keypress refusal for browser chords.** The keypress action's own description
now says browser tab/window/address-bar chords are refused. Try one anyway (e.g. a
new-tab or address-bar chord) against a Chrome window and confirm it's actually refused with a
named reason, not silently accepted or silently ignored.

**5. Self-triggered Compact & Resume — the two things this pass fixed.** Push your own context
past this app's auto-compaction threshold (read a large file, take several screenshots). Once a
handoff lands you in the replacement chat:
   - Confirm the brief arrived and `session` shows one lineage across both chats.
   - Note the exact landing time, then do a few ordinary tool calls (nothing designed to
     inflate tokens). If a second handoff fires within a couple of minutes with no real new
     work behind it, say so explicitly with both timestamps — a prior pass found and fixed
     exactly this, and this is the re-test.
   - If you can, trigger a **second** compaction from the replacement chat (so you go
     A→B→C) and confirm the lineage still reads correctly across both hops.
   - If nothing makes this reachable, mark SKIP with the reason.

**6. Goal/Loop.** Turn Goal on with a real short objective, let it draft/pick up once, turn it
off, confirm it stops. Confirm Goal and Loop remain mutually exclusive.

**7. Report.** One line per section — PASS, FAIL with exact evidence, or SKIP (AUTONOMOUS
LIMIT) with the reason. Flag anything slow, fragile, or surprising even where it technically
passed.
