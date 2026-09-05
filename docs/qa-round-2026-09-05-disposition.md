# Disposition — release sign-off round of 2026-09-05

Every item the macOS Claude Code report and the parallel ChatGPT run raised, and what happened to
it. Written so the next reader does not have to reconstruct which findings were defects, which
were correct behaviour, and which were gaps in evidence rather than in the app.

Evidence is named where it exists. "Live" means driven against a real page or a running app on
this branch, not asserted from a test.

## Defects, fixed

| Item | Cause | Evidence |
| --- | --- | --- |
| **Dropdown never changed** (ChatGPT 41) | `set_value` was click + select-all + insertText. Chrome paints a native `<select>` popup in the browser process, so no synthetic event reaches an option — the call succeeded and did nothing. | Live on `/dropdown`: `{"set":"g1_e0","value":"1","selected":"Option 1"}`. Unmatched option refused by name with the options listed, control untouched. |
| **`/hovers` exposed no refs** (ChatGPT 47) | `observe` collected only interactive elements. The wrapper is a plain `div` and the caption is `display:none` until hovered, so `move_ref` had nothing to aim at on its own headline case. | Live on `/hovers`: all three targets exposed, `move_ref` reveals the caption. |
| **Logout did not actuate** (ChatGPT 44) | Not a click defect. A Chrome-native password dialog over the tab swallows input; `elementFromPoint` cannot see browser UI, so `covered` is honestly false and the click reports success. | Both halves measured. From a clean profile the real button **worked** — `hit=i covered=false navigated=true` → `/login` — carrying the exact signature the failing runs reported, so that signature was never the cause. With the dialog present, the click now reports `navigated=false` with the address and the remedy. See the final round below. |
| **Chrome error page returned as the site** (ChatGPT 76) | `chrome.tabs` and `Page.getNavigationHistory` both report the *requested* address for a failed load. Only the frame tree reports `chrome-error://chromewebdata/`. Every guard was asking a lying surface. | Measured against a dead port; `verify:browser` covers refuse → stay detached → and still be able to leave. |
| **A stalled compaction took browser recovery with it** (Finding 1, recovery half) | `inspectSilentChats` skipped a chat for the whole life of a continuation, not just while it was being chased. | Two tests, each confirmed failing without the fix, and **confirmed live** — see below. |
| **A handoff open across a restart, same shape** | A continuation restored from disk never gets a watch, and "no watch yet" was read as "about to be armed". | Test confirmed failing without the fix. |
| **The `exec_command` path contract was half-stated** (Finding 2) | `workdir` accepts virtual paths and always did; `cmd` is not translated. The description said neither. | Confirmed live both ways in the reporting round. |
| **A stale "Waiting for N tool calls" panel** (Finding 3) | The count describes another process's memory and nothing expired it, so a failed poll froze the last number forever. | Confirmed live: cleared at 61 s where it had survived ten minutes. |

## Correct behaviour, made easier to act on

The report's closing judgement was that the app's failures are refusals, they are correct, and a
run that meets four in ten minutes reads a pattern rather than four right decisions. No fence was
weakened. Two refusals now name the remedy they already knew:

- `WORKSPACE_REQUIRED` lists the approved roots. A worker meets this on its first command.
- `INPUT_TARGET_LOST` / `STALE_UI_SNAPSHOT` / `FOCUS_FAILED` against a browser window point at the
  `browser` tool, which drives a page over CDP and needs no desktop focus. That sentence existed
  only in a source comment.

The `WORKSPACE_REQUIRED` fence itself was deliberately left alone. Skipping it when a single root
is approved looks safe and is not: the failure it exists for happened *inside* one root, so a root
count cannot see the ambiguity.

## Not defects

- **The model denied having an `agents` tool, then used it.** The app exposed it throughout. A
  report that took the first answer at face value would have filed a phantom bug.
- **Unattributed repair fired twice.** Triggered by the reporting harness's own unattributed calls.
- **`INPUT_TARGET_LOST` against a browser.** The fence failing closed on honest ignorance of where
  input would land, which is its job. Only the message changed.
- **Test and check counts differing from the brief.** Both suites are platform-gated. The briefs no
  longer quote totals, because a Windows figure reads as a regression on macOS.

## Closed since, by later rounds and by measurement

- **Finding 1, live — confirmed.** The wall was thought to be fifteen minutes of ChatGPT transport
  failing. The cheaper door is a restart: a continuation opened before `compactionWatchFloor` is
  permanently "not chased", which is the same state the fix releases. `verify:compaction-release`
  drives it, and the run is decisive both ways — with the fix, the app handed out
  `{"reason":"silence"}` for a chat holding an open automatic continuation; with the floor check
  removed, nothing for four minutes. Fixed twice across three rounds and confirmed zero times; it
  is confirmed now.
- **The connector path.** The second ChatGPT round ran fully attributed and passed all ten steps,
  including quoting back the render truncation before it was reported to them. One real defect was
  found at that layer beforehand: a note long enough to be truncated past its own remedy.
- **A mid-generation block, driven fresh.** Driven on this build in the second macOS round: blocked
  one second after the command started, the turn closed itself, `CHAT_BLOCKED` was quoted verbatim,
  and tools returned three seconds after release.
- **A worker blocked mid-run.** Slot freed, run parked, zero `AGENTS_BUSY`. Also pinned by a test
  confirmed to fail against a simulated deadlock.

## The final delta round

Run against `1a26155`, after upstream's three PRs were merged in. Zero FAILs, no code changes
needed. The two results worth keeping:

**The merge conflict was resolved correctly, and the reason is not the one I argued.** Both sides
had changed the pointer-report line; I kept both halves on the reasoning that "is this the right
frame" and "is the point inside it" are separate questions. On the test hardware the frame was
*current* — so upstream's generation gate was never what stood between the caller and a bad
coordinate. The bounds check was:

    Pointer desktop: 540,701. It is outside frame 3, so it has no position in that image.

Verified independently of the app, with an OS-level `screencapture` putting the pointer at desktop
`539,300` against a reported `540,300`. Had upstream's line been taken alone, that exact case would
have regressed to the `875,754` shape QA originally found. The round's own summary: keeping both
"was not belt-and-braces, it was the difference between correct and regressed".

**The truncated note is confirmed live**, which the macOS round could not do — the `browser` tool is
attribution-fenced, so a swallowed click needs a real ChatGPT turn. The parallel ChatGPT round
produced one, dialog and all:

    click_ref: clicked={"x":431,"y":230,…} hit=i covered=false navigated=false
    expected=https://the-internet.herokuapp.com/logout
    note=delivered, but the page did not go there. A Chrome password or permission dialog in front
    of the tab can swallow a click invisibly. Check the screen, or use navigate to reach the
    address directly.

Full sentence, ending in the remedy, no ellipsis — through the real MCP render path. And the cause
was on screen: a Chrome-native "Passwort ändern" dialog warning the password was found in a breach.
That closes the loop opened when the same button failed twice with no explanation.

## Open

Nothing from any report. The remaining risk is the shape the third round named rather than a
defect: this app's hardest behaviour lives in recovery paths, and recovery paths are the ones
nobody drives by accident. Two of them — the compaction chain and the compaction release — now have
scripts instead of judgement calls.

One caveat the final round raised about itself, kept because it is fair: its evidence is a mix of
driven and read. It drove the bounds half of the merge and read the generation half — the macOS
helper is an in-process addon, so there is no separate process to kill and no way to induce a stale
generation from outside. Upstream's own test covers that half and the merged form passes it. The
distinction between "confirmed on hardware" and "confirmed by reading the code plus its test" is
worth carrying into the PR rather than flattening.

## Gates at the time of writing

    npx tsc --noEmit               clean
    npx vitest run                 2411 passed, 27 skipped
    npm run verify:browser         73/73 against real Chrome
    npm run verify:compact-chain   7 checkpoints + control, app running
    npm run verify:compaction-release   open → restart → check, confirmed both ways
    npm run verify:privacy         passed

Upstream: 0 behind, v2.0.5 still upstream's newest tag.
