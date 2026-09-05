# Everything Claude Code runs on the Mac

Six parts. They are worth running because this machine can answer questions no other can: it has
Accessibility, a screen with a real compositor, and the packaged app as installed. A build machine
has none of those, and the repository's own suites say so out loud rather than passing — part 2
below turns three of those skips into answers.

Nothing here needs ChatGPT, and nothing here needs a person: every step is a command you can run.
Parts 1–4 do not even need the installed app; part 5 does.

## This round is the release-readiness pass — run all six parts in full, not just the deltas

Every round since `ff8c161` has been narrow on purpose: one finding, one fix, one targeted
re-check. That was right while each fix was unproven. It stops being right now — a long chain of
narrow confirmations is not the same thing as one look at the whole surface at once, and a
"flawless before we ship" bar needs the second kind, not another twelfth round of the first.
**So: run every part below in full, including what earlier rounds already confirmed.** Don't skip
a section because a past round passed it — the point this time is one comprehensive pass a
release decision can actually rest on, not one more incremental diff.

**What's accumulated since the last full six-part round (`416a060`), for context — verify all of
it fresh rather than trusting this summary:**

- The 120 ms scroll ceiling reads the real clock now (`settledScrollState` /
  `ProcessInfo.processInfo.systemUptime`).
- `moved: null` for Chromium content was investigated to the end (60-step AX walk, both Chrome
  and this app's own Electron surface, nothing scrollable at any depth) and is a correct final
  answer, not a defect.
- The `pre-push` hook now finds `node` in common install locations.
- Checks 33/45/46 shared one cause — a backgrounded driven tab — fixed by activating it before a
  scroll or a click, confirmed against the exact repro that found the bug (7275 ms → 528 ms,
  `moved: false` → `true`, `createdTab` 0/5 → 5/5 backgrounded).
- That fix's own cost (an unconditional real macOS application switch, 1191 ms, TextEdit → Chrome)
  is now paid only when a lighter tab-activation alone does not recover `visibilityState` — which
  turned out to be almost never; the ordinary "working in another app" case never escalates.
- **Confirmed, not just fixed:** the minimized-window escalation case that used to measure
  `broughtToFront: false` when the switch had, in fact, happened now reports `broughtToFront: true`
  — two rounds running, the second with its own dedicated `verify:browser` check ("a minimized
  driven window escalates and correctly reports broughtToFront"). Nothing left to re-derive here;
  an ordinary regression check going forward.
- The read-only hint's indent (`0af28f0`) has a DMG to check it against now. Predicted:
  `PERMISSIONS` and the hint both sit at `x=354`.
- `Poll errors 1` / "13 problems" was seen once in the health/activity header, unexplained. Note
  whether it's still there; this pass is a reasonable place to also just look, not only re-test.
- **Driver/build provenance, explained rather than fixed.** The last ChatGPT run flagged the
  packaged `browser-driver.js` digest staying identical across a Core version bump as ambiguous,
  proven not to be stale Chrome. It's not a bug: `244aaff` and `45c602e` touched TypeScript, CSS
  and docs only — nothing under `extension/`. An unchanged digest is the correct answer for a
  round that shipped no extension change; note in your report whether that's still true for
  whatever commit you're actually running against.
- **The invisibly-scrolling Permissions box is fixed, not just opined on.** The indent fix above
  pushed the read-only hint onto a fifth line, which is exactly what turned "three of six rows
  visible" into "a row sliced in half at the bottom with nothing on screen explaining why" —
  confirmed against the DMG this round measured. Every `.scroll` card (Permissions, Folders,
  Health, Activity) now fades toward its own background at whichever edge still has more content
  behind it. **Re-check this as a confirm, not an opinion**: scroll the Permissions card to where a
  row would land on the fold, and say whether it now reads as "more below" rather than as clipped.

**One UX opinion still open, still not asked as a numbered check:** a permission row has no
"checked Ns ago" the way the header line does. Give a real opinion this round rather than carrying
it forward again.

**What "flawless" actually means for this pass:** not zero findings — a comprehensive pass that
finds something real is more valuable than a narrow one that finds nothing. Report exactly what
each part shows, the same evidence-first way every round before this one has.

Paste everything below the line into Claude Code on the Mac.

---

You are verifying a macOS desktop-automation app called Chat On Steroids, from its repository, on
the machine it is meant to run on. Six parts, in order. Measure rather than reason: report what you
observe, including where it contradicts what the source says should happen. A contradiction is the
more valuable result — three rounds of this work have already been corrected by measurements that
disagreed with reasoning.

## 0. Setup, and the permission that decides whether any of this means anything

```sh
git clone https://github.com/Maximapple/chat-on-steroids.git ~/chat-on-steroids   # skip if present
cd ~/chat-on-steroids
git fetch origin && git checkout integrate/browser-and-desktop-064733 && git pull --ff-only
npm ci
node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch arm64
```

That leaves the helper at `resources/packaging/desktop/darwin/arm64/macos-desktop-helper`. It
speaks newline-delimited JSON on stdin and stdout; `{"op":"warm"}` is the cheapest call and its
reply carries `screenPermission` and `accessibilityPermission`.

**Two shapes for focus, and they answer different questions.** `{"op":"focus","id":N}` takes the
window id under `id` — pass it as `window` and the helper reads 0 — and it answers only
`focused: true|false`, never a reason. The reason comes from
`{"op":"act","actions":[{"type":"focus","window":N}]}`, which is the path that throws
`FOCUS_FAILED` with the clause that refused. Part 3 needs the second one; run both, since the
first tells you whether focus succeeded at all.

**Screen Recording and Accessibility must be granted to whichever application owns the terminal.**
macOS attaches the grant to the GUI ancestor — usually `Terminal.app` or your IDE — never to
`node`. Ask the helper for `{"op":"warm"}` and report both flags before anything else. If either
is false, say so plainly and say which parts below are therefore unmeasurable, rather than running
them and reporting nils as findings.

## 1. The suites, as they run anywhere

```sh
npm run verify:ci
```

Report the totals and anything that failed. This is the baseline: it should be green, and a
failure here changes what everything after it means.

## 2. The three things only a real screen can judge

A build machine drives no compositor and holds no Accessibility grant, so the repository's own
checks skip these and say why. This machine can answer them.

**2a. Browser driver, with a visible browser.**

```sh
npm run verify:browser -- --headed
```

Thirty-six checks against real Chrome. Scroll was the thing to watch, and the last run from this
machine is what finally explained it — the fault was in the harness, not in the browser. It opened
the extension popup as a new tab, which left the page under test in the *background*, and a
background tab is given no frames. `--headed` never helped because headed against headless was
never the axis; active against inactive was. Measured there: `visibilityState` was `"hidden"` while
the browser window stood plainly in front.

The fixture is activated before the scroll check now, and the direction is judged rather than
skipped — `0 → 300` even on a build machine with no screen at all, which is the first time this has
been judged anywhere.

Report the tally and every FAIL verbatim, and then specifically:

- Did **a positive scroll_y moves the page down** pass? It should, with real numbers on both sides.
- What `scrollTop` did it report before and after?
- Did **the page sees a trusted wheel event going down** pass, and with what deltaY?
- If a SKIP line appears at all, quote it in full. That would mean this machine cannot composite
  what it is being sent, which is a new finding rather than the old one.
- Did **a screenshot of a scrolled page shows where the page is** pass? This is new, and it is the
  check that finally caught a defect two QA rounds reported and nothing here could see: the fixture
  carries a coloured band at a known document offset, and the check works out which image row it
  must land on. It fails on the old code and passes on the new — both were watched. Report the
  scrollTop and the row it names.

**2b. The helper, running for real.**

```sh
node scripts/probe-macos-helper.mjs arm64
```

Report the tally and every failure. With permissions actually granted, checks that a build machine
sees refused should now do the thing instead — say which ones changed behaviour compared to what
the script says to expect.

Two changes since your last run, both from what you measured. It now prefers **its own** window —
the one titled `cos-probe-window.txt` — over the first usable one in the list. And the pointer
check reports `N changed within 32px of the pointer, M elsewhere` with both densities, then either
confirms or says the whole window was repainting. **Run it once on a busy desktop**, browser
windows and all, and say whether it still reaches a verdict. That was the condition it failed under
before, and it is the condition that matters.

**2c. The pointer, in a picture.** This is the oldest disputed claim in this project: the pointer
was reported as drawn when it was not, twice.

Open TextEdit with a document. Move the mouse into the middle of its window. Then, driving the
helper directly, capture that window (`{"op":"windows"}` to find its id, then
`{"op":"capture","id":<id>,"maxWidth":640,"file":"/tmp/shot.png"}`) and report the `pointer` field
of the reply verbatim — it is one of `drawn`, `outside_region`, `unavailable`, `buffer_unavailable`.

Then **look at the PNG** and say whether an arrow is actually visible, and whether its tip is where
the mouse was. The reply field and the picture are two different claims; report both, and say
plainly if they disagree.

Repeat with the pointer moved well outside that window. The field must say `outside_region` and the
picture must contain no pointer.

## 3. Focus — confirming an answer, not looking for one

This part was a hypothesis until the last run from this machine settled it, and settled it against
me. `FOCUS_FAILED` was not about Chromium's accessibility tree. Chrome's main window focuses in
every state tried — page loaded, cursor in a page text field, focus in the address bar — and
TextEdit never refuses at all. The one thing that refuses is the **transient omnibox container**:
a second Chrome window that appears on Cmd+L, `136` tall and as wide as its parent (the last run
measured 874, not the 1402 an earlier one did), titled "Google Chrome window", which
`{"op":"windows"}` lists like any other and which a caller can address by mistake. Press Escape and
it disappears, and the main window focuses again.

The reason given was `another window of the same application is in front` — the second reason in
the list, not the accessibility one. Two things changed because of that:

- The reason **now names the window that is in front**, because "another window is in front" left
  nothing to do about it, while an id can be targeted or dismissed.
- Nothing was relaxed in the fence. It refused correctly; the caller was aimed at the wrong window.

So this part is now confirmation, and one open question.

**3a. Confirm.** Do all of this yourself; nothing here needs a person.

Open Chrome on an ordinary page (`open -a "Google Chrome" https://example.com`). Focus its main
window via `{"op":"act","actions":[{"type":"focus","window":<id>}]}` — it should succeed. Then open
the omnibox with the helper rather than by hand:
`{"op":"act","actions":[{"type":"focus","window":<id>},{"type":"keypress","keys":["command","l"]}]}`.
List windows again: a second Chrome window around `1402x136` should have appeared. Focus that one
and quote the refusal — it must read `another window of the same application is in front (window
N)`, with N the main window, and N must appear in `{"op":"windows"}`. Then dismiss it with a batch
that focuses the main window first, since a keystroke on its own is refused:
`{"op":"act","actions":[{"type":"focus","window":<main>},{"type":"keypress","keys":["escape"]}]}`.

**Then ask `find_ui` about the container, addressing it under `id`.** Expect it to answer with the
container's *own* tree, at the container's own size — that is the correct behaviour and your last
run measured it. `UIA_NO_OWN_WINDOW` guards a case no known application produces; if you ever see
it fire here, that is the finding.

**And confirm the wrong key is still refused.** `{"op":"find_ui","window":N}` must answer
`BAD_REQUEST` naming both keys, rather than silently reading 0 and answering about the foreground
window. That silence cost you a whole round; check it on `find_ui`, `focus`, `capture` and
`snapshot`.

**3b. Built on your measurements — three things to check.**

You answered both questions, and both answers were acted on.

- **`focusable` exists, and it is opt-in.** `{"op":"windows","focusable":true}` reports it per
  window; a plain `{"op":"windows"}` does not, and pays nothing. Your numbers are the reason: the
  attribute costs 0.05 ms a window, reaching the element to ask costs 112–117 ms for a list of 26.
  Check that the omnibox container comes back `false` and ordinary windows `true`, and time both
  forms of the call. A window whose reading fails is reported `true` — refusing to drive something
  on a failed reading is worse than the reading's absence — and one with no element at all is
  `null`.
- **The title tie-break is now on the focus path too**, which is what your last run showed was
  missing. It went into `matchingAXWindow` and not into `unambiguousWindowID` — the function every
  focus and every input target goes through — so `find_ui` could separate two identical windows
  while any batch starting with `focus` still failed, and a focus that had *worked* was reported as
  `FOCUS_FAILED` because the window in front could not be attributed. The ChatGPT run met the same
  message from the other direction. Rebuild your 3b/2 case exactly — two Finder windows, same size,
  same position, different titles — and confirm the drag now goes through on the first attempt.
- **`focusable` says why it does not know.** When the answer is `null` there is now a
  `focusableUnknown` beside it, reading `"ambiguous"` or `"unavailable"`. Your three identical DMG
  windows should read `ambiguous`; a window with no accessibility representation at all reads
  `unavailable`. One of those a caller can act on, the other not, and `null` alone said neither.
- **With the *same* title as well**, confirm the refusal names the candidates it could not
  separate, rather than only saying it could not.
- **The `UIA_NO_OWN_WINDOW` comment says what you measured**: the attribute is unsupported here,
  -25205, none of 26 windows matched by id. Nothing to test; it is recorded so the next reader is
  not told an anecdote.

**3c. This round, both items come from findings — yours and ChatGPT's.**

- **Your `snapshot` finding is fixed at the root you named.** The enumeration is gone. The test now
  asks what the failure *is*: only a target-identity failure — `WINDOW_NOT_FOUND`, `WINDOW_MOVING`,
  `BAD_REQUEST` — discards the capture, and every other failure keeps the already-valid image and
  reports `uiUnavailable`. So the next code split cannot take a code off a list again.

  Your own measurement has already been repeated on your machine, so do not spend the round on it:
  two Chrome windows at 200,200 800x600 both titled `Example Domain` — identical geometry and
  identical title, which is the condition — and `snapshot` with `includeUi` answered `ok: true`,
  `image: {1280x960}`, `uiUnavailable: {"code": "UIA_AMBIGUOUS_WINDOW", …}` for both of them.
  Before the fix that was `ok: false, image: null`. Confirm it in passing if it is free; the
  picture is what makes the refusal’s advice — move or close one of them — followable at all,
  which was the worse half of that defect.
- **A scroll now reports what happened to it.** ChatGPT met a native scroll answering `Done` with
  the document unmoved, and nothing in the reply separated "the app ignored the wheel" from "the
  wheel went somewhere else" — the window server delivers a scroll to whatever is under the
  pointer, which need not be the window holding the lease. `act` now returns a `scroll` object:
  `hitPid`, `hitRole`, `reachedTarget`, and `positionBefore`/`positionAfter`/`moved` read from the
  scroller itself, and both are proven: your ten scrolls composed to six decimal places, and the
  tenth correctly reported `moved: false` at the end of the document.

  **You asked the cost question and answered it, so the wait is now built on your number.** 2495 ms
  for ten scrolls, 234 ms each, against a scroller that finished moving after 21 to 26 ms — the
  wait was roughly five times the thing it was waiting for. I did not take your 50 ms: a second
  fixed number would have been a second guess, and you were explicit that you had not measured an
  animating scroller. It now polls every 10 ms until two readings agree, with your 120 ms as the
  ceiling, so nothing waits longer than before and an animated scroller is still waited for. One
  subtlety your data forced: the poll compares against the reading taken *before* the wheel, not
  against itself, because at 10 ms nothing has moved yet — comparing a reading to itself would
  answer `moved: false` a third of the way to the movement even starting.

  **Re-run your ten-scroll measurement.** I expect roughly 40 ms per scroll where it moves, and the
  full 120 ms only where it does not — the end-of-document case. If an animating scroller is within
  reach, that is the one measurement neither of us has.

  One subtlety worth knowing before you read the numbers: the poll compares each reading against
  the one taken *before* the wheel, not against its predecessor. Comparing a reading to itself
  would have answered `moved: false` at 10 ms — a third of the way to the movement even starting,
  by your own figures — so the loop waits for a change first and only then for stillness. That is
  why an unmoved scroll still costs the full ceiling: nothing distinguishes "will not move" from
  "has not moved yet" except time.

**Nothing else in the helper changed this round.** Three cloud reviews went over the code and
their six findings were all in the browser driver and the tool layer — the address refusal, a
navigation that did not check where it landed, a missing build stamp, two display fields, a drag
without a hold, and two schemas disagreeing about a coordinate. None of them touches anything you
measure here, so treat Parts 0 through 4 as a regression pass and spend the time you save on the
scroll cost above.

**And the older open question, for reference.** Your answer last round — list it, do
not exclude it, and carry the difference in a field such as `focusable: false` — is the one I
agree with. Two things have to be true before it can be built, and only this machine can say
whether they are.

The cheap signal does not work: the helper already filters the window list to `layer == 0`
(`main.swift:216`), so the container is a normal-layer window and its layer cannot tell it apart
from any other. That leaves whether it can be made main at all. So, using the Accessibility API
directly rather than the helper:

- For the omnibox container **and** for Chrome's main window, report whether `kAXMainAttribute` is
  settable — `AXUIElementIsAttributeSettable(window, kAXMainAttribute, &settable)`. If it comes
  back `false` for the container and `true` for the main window, that is the field's definition and
  I will build it on that.
- Then time it: how long does one such call take, and how long would it take for every window in
  a 25-window list? `windows` is called constantly, and a field that turns a fast list into a slow
  one is not worth having. Say what you measure; if it is expensive, say so and I will make the
  field something a caller asks for rather than something every list pays for.

## 4. Input, at the level under the app

Still driving the helper directly, so a failure here is the helper's and not the app's.

**Three call shapes the last run had to discover by hitting them.** `drag` takes `xs` and `ys`,
not `path`. `targetWindow` belongs on the request, beside `actions` — putting `window` on the
action leases nothing and you get `INPUT_TARGET_REQUIRED`. And a keystroke needs a window, so put
`{"type":"focus","window":N}` first in the same batch.

**4a. A drag that moves something.** Put a file and a target folder in one Finder window. Ask the
helper to drag the file onto the folder — a `{"op":"act","actions":[…]}` batch with a `drag` whose
path has several points, not two. Check the filesystem afterwards. Report whether it moved, and how
many points the path had.

**4b. Typing where it was aimed.** Focus a TextEdit document, send text through the helper, and read
the file back. Confirm the characters arrived exactly, including any line break.

**4c. The input fence refuses what it cannot prove.** With TextEdit in front, ask the helper to send
input aimed at a *different* window's id. It must refuse by name — `INPUT_TARGET_LOST` — rather than
type into whatever happens to be focused. Quote the refusal. This is the check that matters most in
this part: a fence that fails open here types into the wrong window.

## 5. The installed app, if one is installed

Skip if no DMG is installed, and say so.

**5a. Build identity, which was broken and is the reason this part exists.**

The last run from this machine found the window title carrying no build at all: Electron replaced
it with the document title as soon as the page loaded, so the one place a build could be read said
nothing, and the run could not determine which app it was measuring. Two things changed.

Ask the app over the loopback bridge — this is new, and it is the answer to "which build is
running" that a command can get:

```sh
curl -s http://127.0.0.1:8765/hello
```

Report `build` verbatim. It must read `2.0.2+<commit>`; `2.0.2-dev` means a working tree rather
than a package.

Then read the window title from the helper's window list for the Chat On Steroids process. It must
now carry the same string. **If the title is still bare `Chat On Steroids`, the fix did not take
and that is the most important line in your report.**

Compare the commit against `git rev-parse --short HEAD`. Say whether they match — much of what
follows only means something if they do.

**5b. The extension Chrome actually loaded.** The app offers an extension folder under Application
Support. Find it, and find what Chrome has loaded (Chrome records unpacked extensions in its
profile preferences). Say plainly whether they are the same directory, resolving symlinks —
`/var` and `/private/var` are the same place under different names. Then diff the loaded
`browser-driver.js`, `background.js` and `popup.js` against this checkout. **Any difference means
Chrome is running an older extension, and nothing measured through it is about this build.**

**5c. The manifest.** In the loaded copy, report `permissions` and `optional_permissions` verbatim.
`debugger` must be in `permissions`, not in `optional_permissions` — Chrome silently drops it from
the optional list, which is what once made browser control impossible to switch on.

## 5b. The surface nobody has tested: settings and the permission step

You noted last round that the onboarding step for permissions was not exercised, and you were
right — no run of any kind has touched it. You are the only one of us who can, because it needs
the installed app on a machine whose permissions can actually be revoked.

- **The permission rows tell the truth, live.** With both permissions granted, capture the
  settings pane and describe each row. Then revoke Screen Recording in System Settings, return to
  the app **without restarting it**, and capture again. The row must change on its own. The app
  re-reads permissions rather than caching them at launch; a row that still says "granted" after
  a revocation is worse than no row, because a person acts on it. Then grant it again and confirm
  the row recovers, again without a restart. Say how long the change took to appear.

  **Fund 2 is closed.** Your last run measured it directly: a long-running process saw neither a
  real revocation (over 4 minutes) nor a later grant (over 2 minutes), while a freshly started one
  saw each immediately — macOS's own per-process TCC cache, which the app's restart note already
  names in its own words at the point someone would hit it. Nothing to re-test unless the timing
  changes; re-run this bullet as an ordinary regression check, not a hunt.
- **The restart note earns its place or it does not.** There is a case where the app tells you a
  restart is needed. Find out which one, and whether the note appears only there. A restart note
  shown when no restart is needed trains people to ignore it.
- **The button goes where it says.** Each row can offer a button that opens the right System
  Settings pane. Confirm the pane that opens is the one named, for both permissions.
- **Fund 1 is closed.** Your last run toggled Read-only and counted rows in both states: on shows
  only Screen Recording, off shows both — exactly what "gated on `control` actually being
  requested" predicts — and the app's own activity log confirms it reads both permissions
  throughout. Nothing to re-test unless the gating logic changes.
- **What it looks like.** Judge the pane as a person: is it obvious what each switch does, does
  anything clip or overlap at the default window size, is any wording ambiguous or alarming
  without cause. Say what you would change. Nobody had ever reported an opinion on this surface
  before your last two rounds, which is not evidence that it was fine.

  **The read-only hint's grid-row fix holds — confirmed two rounds running,** in both Read-only
  states, at the default window size. No longer worth a dedicated look; fold it back into the
  ordinary judgement above.

  **Two things you raised as opinion, not yet acted on.** The box scrolls without showing it — six
  rows exist, three are visible, nothing hints at the other three, and it is what nearly cost you a
  false "Look at files is gone" report. And a permission row carries no "checked Ns ago" the way
  the header line does. Neither has a fix this round; say whether either is still true and whether
  it is still worth fixing, rather than re-deriving it from nothing.

## 5c. Two contracts the helper offers, and two that had never actually held

- **The verification specs — reachable, but not where you sent them.** Your last run sent
  `verification` straight to the helper's `act` and it was silently accepted and ignored,
  answering `ok: true` for a condition that never ran. That contract has never lived in the
  helper: `until: foreground`, `window_exists`, `window_closed`, `ui_appears`, `ui_disappears` are
  implemented one layer up, in `src/main/computer/index.ts`, which turns each into ordinary
  `find_ui`/`get_window_state` polling before it ever reaches this process. So there are two
  separate things to confirm now, not one:
  - **At the helper**, send `{"op":"act","targetWindow":N,"verification":{...},"actions":[...]}`
    directly, the way you did last round. It must now answer `BAD_REQUEST` naming `verification` —
    "act does not recognize `verification`" — rather than `ok: true`. Try a nonsense key too
    (`quatschSchluessel`) and confirm the same refusal, by name.
  - **At the app**, the same four `until` values are reachable through the `computer` MCP tool's
    `verify` argument — that needs a bearer token this document does not carry, so it is
    ChatGPT's to exercise, not yours. Do not re-test it here; confirming the helper now refuses
    what it does not implement is the whole of this round's part.
- **`act_ui` beside `click_ui` — now with the evidence your run asked for.** You measured
  `AXUIElementPerformAction` returning success against a System Settings toggle that stayed
  exactly where it was, and a coordinate click on the same spot moving it — the same shape as a
  scroll gesture that reports "sent" without reporting "moved". `act_ui`'s `click` action now
  reads the control's own value before and after the press and adds `"changed": true|false` to
  its reply (omitted, not `false`, when the control has nothing comparable — an ordinary button).
  Reproduce your exact case if the same stubborn toggle is still reachable; otherwise pick any AX
  switch or checkbox, press it once through `act_ui`, and confirm `changed` matches what actually
  happened. Then exercise the same action inside a batch (`{"op":"act","actions":[{"type":
  "click_ui",...}]}`) and confirm the batch's own reply carries `"ui_changed"` the same way.
  Separately, still worth doing once: exercise `act_ui` on a control a coordinate click would also
  reach, and on one it would not — a menu item that only exists while a menu is open — and say
  which route each needed, and whether the refusal for the impossible case names what was wrong.

## 5d. The stray-key rule, one door down from `act`

**"Die Schlüsselprüfung ist auf `act` beschränkt... beim dritten Mal, dass eine Regel als
Einzelfall repariert wird, ist das Muster selbst der Befund."** You measured that `windows`,
`warm` and `cursor` took any key at all — a typo, a field that belongs to a different operation,
anything — and silently did nothing with it, answering `ok: true` for a field never read. Confirm
each of the three now refuses by name instead:

- `{"op":"warm","verification":{}}` and `{"op":"cursor","window":1}` must both answer `BAD_REQUEST`
  naming the stray key, not `ok: true`. Neither operation reads anything besides `op`.
- `{"op":"windows","quatschSchluessel":true}` must answer `BAD_REQUEST` the same way.
  `{"op":"windows","focusable":true}` must still work — `focusable` is the one field this
  operation legitimately reads.
- A well-formed call to all three — no stray key — must be unaffected. This is a regression check
  as much as a new-behaviour one.

`find_ui`, `act_ui`, `capture` and `snapshot` deliberately do not have this check yet: they read
enough fields, some forwarded from `snapshot` into the other two, that enumerating them safely is
its own round rather than being guessed at here. Do not report their continued silence on a stray
key as a regression; it is the documented scope of this round, not an oversight.

## 5e. The extension popup and its toolbar button — both closed, one as a fix, one as a known limit

Two rounds of instrumented pixel/AX evidence closed both findings from `9f9160b` for good — the
second round specifically to answer whether the checkbox press was a popup quirk or something
bigger, using `scripts/diagnose-popup-checkbox.mjs` against a brand-new, plain Chrome tab holding
nothing but a checkbox. It was bigger.

**The `changed: false` false negative is fixed.** Chromium answers `AXValue` with an *empty
string* for a checkbox or a toolbar button — measured on the popup's own controls and, this round,
confirmed on an ordinary page's plain `<input type="checkbox">` too — rather than omitting the
attribute the way AppKit does. An empty string equals itself, so comparing it before/after a press
always reported `changed: false`, when the field's own contract says to omit it when there is
nothing comparable to say. `axComparableValue` now treats an empty AXValue as no value at all, and
the diagnostic script confirmed it: the reply on a fresh checkbox came back with `changed` absent
entirely, not `false`. Nothing left to re-check here.

**The checkbox never actually toggles through a semantic press — confirmed general, not a popup
quirk, and not going to get a fallback-to-coordinates fix.** `scripts/diagnose-popup-checkbox.mjs`
proved it on a plain page: `AXUIElementPerformAction(kAXPressAction)` returns success and changes
*nothing* — before/after screenshots came back byte-identical, 0 pixels differ — while a coordinate
click on the same spot filled the box immediately (65 pixels changed). Chromium simply never
populates `AXValue` for a checkbox in *either* state, checked or not, which is also why `changed`
can never be anything but absent for one: there is nothing to compare, ever, not just this once.

This is not new behavior for this app to guess a workaround for — it is the same shape as the
System Settings toggle finding that `changed`/`ui_changed` was built to report in the first place:
an accessibility press that claims success without a real effect, on a *native* control that time.
The established answer both times has been to report the truth rather than silently retry, so a
caller stays the one deciding whether and how to recover — not to bolt an automatic
coordinate-click fallback onto `act_ui`, which would risk double-toggling a control on the rarer
occasion "no effect" is the correct outcome. **Practical guidance going forward: a checkbox or
toggle inside a Chrome tab should be driven with the `browser` tool's `click_ref` instead of the
native `computer`/`act_ui` path** — `click_ref` reaches Chromium content over the DevTools
protocol with real `isTrusted` input, not through `AXUIElementPerformAction`, and every QA round
that has exercised it against a page checkbox has it working. Reserve `act_ui` for native AppKit
controls, where this class of failure has so far only ever been a false-negative *report*, not a
false click.

**One real follow-up, deferred rather than guessed at: `act_ui`'s result-hint text still can't
tell the two cases apart.** When `changed`/`ui_changed` comes back `false`, the tool result already
adds "try clicking the same coordinates instead" — genuinely useful, and still correct for a
native control with a real comparable value. Now that `changed` is correctly *omitted* for a
Chromium checkbox instead, that same caller-facing hint goes silent for exactly the case that most
needs it. The reply from `find_ui`/`act_ui` doesn't currently carry the control's role, so the
result-rendering code in `tools-desktop.ts` can't distinguish "an ordinary button, omitted and
fine" from "a checkbox with nothing to compare, omitted and probably still unclicked" — threading
`role` through `actUI`'s reply in `main.swift` and sharpening that hint is a real, well-scoped
improvement, just not one to rush into the same round as everything else above. Left for a
dedicated pass.

## 6. What to report

Part by part: what you ran, what came back verbatim, and whether it agrees with what this document
says to expect. Then, plainly:

- **Did `npm run desktop:mac` compile at all?** If not, quote the exact `swiftc` error and stop —
  nothing else in this document can mean anything until it does.
- Were Screen Recording and Accessibility actually granted to the terminal?
- `verify:ci` and `verify:browser --headed`: totals, and every failure.
- **Scroll direction: judged or skipped, and the measured scrollTop.**
- **The pointer: what the reply field said, and what the picture showed. Did they agree?**
- Which clause refuses a Chrome focus request, quoted.
- Did the drag move the file, and did the input fence refuse a mis-aimed keystroke?
- Does the extension Chrome loaded match this checkout?
- **`act` with a top-level `verification` key: `BAD_REQUEST` naming it, or still silently `ok`?**
- **`act_ui` on a real toggle: does `changed` (or `ui_changed` inside a batch) match what the
  screen actually showed?**
- **`warm`, `cursor` and `windows` with a stray key: `BAD_REQUEST` naming it on all three, or
  still silently `ok` on any of them?**
- **The Permissions card: does the read-only hint now sit at x=354, matching `PERMISSIONS`,
  against a real DMG carrying `0af28f0`?**
- **The drag regression: still gone, or back? Two clean rounds so far.**
- **`broughtToFront: true` on your minimized-window repro — does it now match the window state
  and scroll evidence, instead of reporting `false` for a real escalation?**
- **The Permissions card's scroll fade: does a row on the fold now read as "more below" rather
  than clipped? The one open UX opinion left — the missing last-checked timestamp: still true?
  Still worth fixing, in your judgement?**
- **A driven tab's group survives the extension's service worker being killed mid-session — does
  it still get cleaned up? Answered: yes.** Verified 2026-09-03 against `752a07d` in a clean
  Chrome for Testing 152.0.7977.64 profile, driving the extension's own service worker over CDP
  (`scripts/diag-tabgroup-sweep.mjs`). Grouping an already-open ordinary tab, titling the band
  "Chat On Steroids", then firing the `clf-bridge-drain` alarm:

  ```
  using existing tab: 1790622594 http://127.0.0.1:9939/
  groupId: 445767902
  before sweep: [{"collapsed":false,"color":"blue","id":445767902,"shared":false,
                  "title":"Chat On Steroids","windowId":1790622593}]
  after sweep:  []
  tab still exists, ungrouped: {"id":1790622594,"groupId":-1,"status":"complete",
                  "url":"http://127.0.0.1:9939/","index":0,…}
  ```

  **The band is gone, the tab survives ungrouped rather than closed.** Re-run this as an ordinary
  regression check; it needs no person.

  **The "Tabs can only be moved to and from normal windows" error does not reproduce here, and the
  create-then-group race is not the cause.** All three variants pass in a clean profile — including
  the one whose tab was still `status: "loading"` when it was grouped, which is the race that was
  suspected:

  ```
  1) tabs.create({about:blank, active:false}) -> OK {"id":…,"windowId":…,"status":"loading"}
  1) tabs.group sofort danach                 -> OK 494672884
  2) windows.getAll({windowTypes:["normal"]}) -> OK [{"id":…,"type":"normal","state":"normal","focused":true}]
  2) tabs.create mit windowId                 -> OK {"id":…,"status":"loading"}
  2) tabs.group sofort danach                 -> OK 1017720587
  3) tabs.create, dann 600 ms warten          -> OK {"status":"complete","index":4}
  3) tabs.group nach der Pause                -> OK 852233251
  ```

  So the failure is **specific to the live browser's window state**, not to tab freshness and not
  to Chrome 152 in general. Whoever hits it again should capture, at the moment of the throw,
  `chrome.windows.getAll({ populate: true })` and the offending tab's own `windowId`, `index` and
  `splitViewId` — the clean profile had exactly one `type: "normal"` window and no split view, and
  that is the difference this repro cannot see. `groupDrivenTab`'s production path is not implicated
  by anything measured here: it groups a tab it is already attached to, never a freshly created one.

Then anything that struck you as wrong, slow or dangerous that no part above covers. On the last
five rounds that section has been the most valuable part of the report.
