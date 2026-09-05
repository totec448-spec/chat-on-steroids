# Final round — the delta since the last sign-off

Short by design. The previous round closed everything it measured with zero FAILs, and the one
finding it left open has since been confirmed live with a control run
(`npm run verify:compaction-release`). Nothing from either report is outstanding.

What justifies this round is not doubt about those fixes. It is that **217 lines of production
code have changed since the build you last tested** (`52ded86`), and most of them are not mine:
upstream landed three PRs on 2026-09-05 — desktop reply provenance (#74), activity tool details
(#75), folder access (#77) — and this branch merged them. That merge had one real conflict, in a
line both sides had changed. Nobody has driven the merged combination.

Install the macOS arm64 artifact from the newest green *Release candidate* run, then:

    npx tsc --noEmit
    npx vitest run
    npm run verify:privacy
    npm run verify:browser
    npm run verify:compact-chain

Judge by failures, not totals — both suites are platform-gated.

## 1. The merge conflict, which is the one thing worth real attention

`src/main/computer/index.ts`, in the pointer report. Both sides changed the same line:

- **Upstream:** `qualifiedFrame(…, generationOfReply(reply))` — a frame from an older capture
  generation does not describe what the helper just answered about, so it must not place a point.
- **Ours:** a bounds check — the conversion is arithmetic and answers for any point on the desktop,
  so a pointer below a captured window once reported `875,754` for an image 646 tall.

I kept both, on the reasoning that "is this the right frame" and "is the point inside it" are
different questions. Upstream's own new test for that code passes against the merged form, and so
does ours. Confirm on real hardware: screenshot a window, `move` the pointer **outside** it, and
observe. `image` should be `null` and `screen` should still be exact. Then move it inside and
confirm `image` is a real coordinate. If either is wrong, the merge is wrong and I want to know
before this is proposed upstream.

## 2. Upstream's three PRs, briefly

Never exercised here. A pass each is enough:

- **Desktop reply provenance** — the code above; item 1 covers it.
- **Activity tool details** — native disclosures on activity tool rows. Look at a chat with tool
  calls in it and confirm the rows render and expand.
- **Folder access stays editable after setup** — open settings after completing setup and confirm
  the folder controls are still usable.

## 3. My two changes since your build

- **The truncated note.** You caught this one yourself and quoted it: a `click_ref` that reached
  nothing ended in `…a Chrome password or permission dialog in front of th…`. The MCP layer prints
  every field a driver returns and truncates anything past 200 characters; the note was 315. It is
  196 now. Reproduce the swallowed click and confirm the sentence ends with the remedy —
  `use navigate to reach the address directly.` — and no ellipsis.
- **`INPUT_TARGET_REQUIRED` now points at the browser tool**, like the other input fences. You hit
  it twice in four minutes driving a browser. Confirm it names the browser tool, and that
  `STALE_FRAME` still does not — that one is an answer about the screenshot, not about aiming input.

## Report

A line per item. If everything passes, say so briefly — the interesting outcome is a disagreement,
particularly on item 1.

Then the release question one last time: **is there anything here you would not ship?**
