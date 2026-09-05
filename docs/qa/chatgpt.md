# The full run — everything ChatGPT tests, without asking you anything

Thirty-three checks — numbered 1–25, 30–34, 37, 39 and 40 — all of them driven by the model
itself. Nothing here asks a person to look at a screen, click a permission, or read a window title.
(The last run counted them and found the header claiming thirty-four; it was right.)

Six checks from the old script are deliberately not here: 26–29 look at the onboarding screen, and
35, 36 and 38 need a permission switched off and back on. Chat On Steroids hides its own windows
from everything the model can see — deliberately, so the model cannot drive the app driving it —
and `tccutil` can revoke a permission but nothing can grant one back without a person. All six
passed on the last run; they are the ones to do by hand when there is time, and only then.

## Before you paste

1. Install the current DMG and open the app.
2. Reload the extension in `chrome://extensions`. The browser driver ships inside the extension,
   not the app, so a new package alone changes nothing in Chrome.
3. **Then reload the ChatGPT tab itself** — Cmd+R. Reloading an extension orphans its content
   script in every page already open, and that script is the first link in the chain that tells the
   app which conversation is calling. Skipping this cost an entire run: with a multi-agent run
   parked in the past, every Desktop call was refused with `CALLER_IDENTITY_REQUIRED` before it
   reached macOS, and all 47 checks came back unperformable.
4. **This round you do not need to recreate the Desktop connector.** A connector caches the tool
   list it fetched when it was made, so it only has to be rebuilt when that list changes — a new
   action, a removed one, a changed description. Since the build your last run tested, none of
   those changed: the only schema edit was numeric bounds on coordinates that already existed.
   `move_ref` was already there and your last run called it. Three earlier runs were lost to
   skipping this step, which is why it has been stated every time; stating it when it is not
   needed is its own kind of wrong, so it is stated accurately instead. Open a new chat anyway,
   so the run starts with a clean conversation.

That is all. Paste everything below the line.

---

You are testing the desktop and browser automation of an app called Chat On Steroids, connected to
you as MCP apps. Work through every section in order. Everything below is yours to do — do not ask
the person running this to look at anything, click anything, or confirm anything.

## First: establish which build you are testing, yourself

Run this with the Core connector's shell tool:

```sh
curl -s http://127.0.0.1:8765/hello
```

The reply carries `build`, which reads `2.0.2+<commit>`. Report it. If it reads `2.0.2-dev` you
are testing somebody's working tree rather than a package, which is worth saying but not worth
stopping for. If the command fails, the bridge is not running — say so, and note that every
browser check below will therefore fail for that reason and not their own.

Then establish which *extension* you are testing, which is a different question. Call the browser
`status` tool — it needs no attached tab. The reply now carries `build`, a short digest of the
driver actually running in Chrome. **Report it.** Installing a package rewrites the extension
folder on disk, but Chrome keeps running the copy it already loaded until step 2 above is really
done, and a run that measures the old driver while reading the new release notes reports working
fixes as broken. That happened last round. If your `build` equals the one the previous run quoted,
step 2 did not take: redo it, redo step 3, and start again rather than reporting the results.

## This round is the release-readiness pass

Run all 49 checks in full — including everything a past round already passed. Every round up to
this one was deliberately narrow: one finding, one fix, one targeted re-check, because each fix
was unproven and a narrow check was the fast way to prove it. That's not what this round is for.
A chain of narrow confirmations is not the same thing as one look at the whole surface at once,
and "flawless enough to ship" needs the second kind. Don't skip a check because an earlier round
passed it — that's exactly the assumption a comprehensive pass exists to not make.

Two things from the most recent rounds are still genuinely open rather than just unconfirmed —
give them real attention, not a rubber stamp:

- **Check 46's fix (and 45's, and half of 33's) shares one root cause: a backgrounded driven
  tab.** The driver now activates it before a scroll or a click. Confirmed on the exact fixture
  that found the bug; not yet confirmed on whatever fixture this round builds fresh. If your
  driven tab is ever behind the ChatGPT conversation tab — which is the ordinary case, not a rare
  one — this is exactly the condition to exercise.
- **Check 50 is confirmed fixed** (names the capability, e.g. `enable "See the screen"`) —
  reconfirm it holds, since this pass is about the whole surface, not just what's new.

A comprehensive pass that finds something real is worth more than a narrow one that finds
nothing — report exactly what happens, the same evidence-first way every round before this one
has.

## What changed since the last run

**Your last run measured 20–40 second browser calls across a large block of the suite, on build
`244aaff`, and it eventually ran long enough that the surrounding ChatGPT turn was cut off before
the report could be written.** Nothing in `extension/` or the browser driver changed between that
build and now — this is not a fix landing on top of a diagnosed cause, because there isn't one yet.
Everything still passed, so this is a performance observation, not a functional one, but it's worth
isolating rather than re-measuring blind: if it recurs, name which specific operation was slow (not
just "the suite"), and say whether it correlates with anything — a specific tool, a specific
fixture, the point where the settings/Accessibility-tree checks ran. A vague "many calls were slow"
cannot be turned into a fix; three or four named, timed operations can.

**Since your last run, three cloud reviews read this code and found six things.** The one that
matters to you: the rule that keeps this driver out of a ChatGPT tab was a string prefix, so
`http://chatgpt.com/` was never refused — Chrome then redirects it to https with the session still
attached. Check 24 has the four addresses that got through, and one that must now be allowed.
Two others you can see: `observe` prints what a control already holds (check 19), and a drag inside
a page now holds and dwells the way both desktop drivers do (check 42). Also `detach` reports the
driver build, which it did not before — every successful detach used to print `driver build
unreported`, the exact phrase this document tells you to treat as a finding. That was my fault and
it would have sent you chasing it.

**You were right twice, and I was wrong about why.** Last round I told you `hit` and `covered` were
missing because Chrome was probably still running the old extension. It was not. The fields were
there, correct, in the driver — the browser suite proves it — and the tool that hands you the answer
threw them away: every browser action except `observe` and `status` was rendered as the single word
`ok`. Your own diagnosis this round is the right one: *one family of response-shape failures rather
than three unrelated behavioural bugs.* The renderer now prints what the driver actually answered
instead of the fields someone remembered to list, so `hit`, `covered`, and anything a driver adds
later arrive on their own.

**And `status` really did not report `build`.** You could not verify which driver you were testing
because the field existed one layer below and never reached you. It does now, on every branch,
including the one that holds no tab — `; driver build <digest>` or `; driver build unreported`. If
it ever reads `unreported`, that is a finding, not a stale extension.

**Check 14 now answers back.** You reported a native scroll returning `Done` while the document
stayed put, and nothing in the reply could tell that apart from a wheel the application ignored.
The `computer` reply now carries a `scroll` object, and its load-bearing half is
`positionBefore`/`positionAfter`/`moved`, read from the scroller itself. You reported the summary
sentence without the object behind it; the object is now printed after the sentence, so quote it
verbatim, pass or fail. `moved: null` with `movedUnknown` means nothing
scrollable was under the pointer, which is an answer too.

It also carries `hitPid`, `hitRole` and `reachedTarget`, for the case where the wheel reaches a
window other than the leased one — but do not go looking for that case. Measuring it showed the
input-target fence refuses first: bringing another application in front and scrolling the leased
window answers `INPUT_TARGET_LOST` with `no input was sent`, before any wheel exists. That is the
correct behaviour and it is what you should see if you try it.

Two things you should *not* find, because the last run reported them and both were wording rather
than behaviour:

- A `move` to where the pointer already is answers `Done`, and that is correct — the postcondition
  is that the pointer is at the requested point. `POINTER_DID_NOT_MOVE` exists for a move that was
  sent and not delivered, which asking for the current position cannot produce.
- A capture taken straight after a Finder file operation can still show the file where it was.
  Finder repaints on its own schedule; the shell is the settled answer.

Report either only if it behaves differently from that.

**`move_ref` exists now — check 41.** You named it twice as the one action genuinely missing, and
both times you were right: the only route to a named element was a click, which commits to the very
thing a hover was meant to inspect first.

**Check 23, for the third time, and this time the evidence should actually reach you.** `click_ref`
reports `hit`, the element under the click point, and `covered` when something else lies over the
one you named. Quote both. Your observation that a link acquired visited styling while the tab did
not move is exactly the case these two fields exist to settle.

**One from the last run that is still open, and needs a careful answer rather than a quick one.**
Check 17's Tab returned `Done` twice and inserted nothing, on a run where two earlier rounds had it
inserting a tab character correctly. I could not reproduce it from a machine without macOS, and
nothing changed on that path between those runs. So when you reach check 17: read the document back
through the shell **before** sending Tab as well as after, say which window was foreground at the
moment you sent it, and say whether the caret was in the text area or somewhere else. If it fails
again, those three facts are what tell a fix from a guess.

**The two that matter most, from the round before.** Your last run failed check 33 on two
independent pages and was right both times; my previous attempt at it treated a symptom.

- **Every screenshot of a scrolled page was wrong, not just one taken after scrolling.** A capture
  clip is given in *document* coordinates, and the driver always asked for `y: 0` — the top of the
  document. On a scrolled page that region has mostly never been rasterised, so it came back blank,
  with the sliver that did overlap the viewport stranded far down the image. That is exactly what
  you described: blank above, `MARKER 008` left at its old position. The clip now starts where the
  viewport starts.

  This had gone unseen because no check anywhere looked at a pixel of a scrolled page — the one
  that decodes an image only compared its dimensions. There is now a check that fails on the old
  behaviour and passes on the new one, and it was watched doing both.

  **Check 33 is the one to watch, and check 20 with it**: any observation of a page that is not at
  its top went through the same path.

- Two things you reported as contract problems are fixed in the contract rather than argued with:
  the header's check count (above), and the `computer` tool's action list, which now says in the
  schema that only one UI-changing action goes per call. You should no longer discover that rule by
  being rejected.

- **`find_ui` is not on the surface you can see**, and you were right to say so. It is the
  helper's own operation, tested from the Mac. Nothing in this document asks you to test it.

**This round: your 47-check run found six real defects, the most dangerous one this project has
had, and two UI opinions worth acting on. All eight are addressed; here is what changed and what
each check should now show.**

- **Check 44 was the dangerous one.** Refs were numbered fresh from zero on every `observe` —
  `e0`, `e1`, … — so a ref you were still holding from an earlier observation could coincidentally
  match a *different* element in a later one and click it silently, rather than being refused.
  You demonstrated exactly that: an old `e4` survived a superseded observation and activated
  `button#hoverTwo`. Refs now carry the observation that minted them — `g12_e4`, not `e4` — so an
  old label can never collide with a new one again. Re-run 44 and confirm the stale ref is now
  refused as `BROWSER_BAD_REF`, not silently resolved.
- **Check 43** — a ref whose iframe had since navigated away used to leak the raw protocol
  failure, `Page.createIsolatedWorld: {"code":-32602,"message":"No frame for given id found"}`,
  instead of the refusal every other stale ref gets. It is now `BROWSER_BAD_REF` naming the ref,
  same as the rest.
- **Check 45 is a closed gap now, not an open one** — see its entry below; do not report "no way
  to tell" again without first checking for `createdTab`.
- **Check 46** — the false negative was real. Your run saw `BROWSER_SCROLL_FAILED` twice on a
  horizontal scroll while a screenshot taken moments later showed the page had actually moved.
  Move-detection used to read the scroll position exactly once, at the instant a dispatch call
  returned (acknowledged or timed out) — a scroll landing a beat later was reported as failed. It
  now polls briefly for the position to actually start changing before giving up. Re-run the same
  horizontal case and confirm the reply's `moved` now agrees with the screenshot.
- **Check 50** — disabling Desktop used to tear the whole connector's tunnel down, so the *next*
  call died at the tunnel relay with a raw `tunnel_client_not_connected` and never reached this
  app's own refusal at all. The tunnel now stays published once it has been; only the tools
  behind it refuse. This round the refusal should arrive immediately, not after a reconnect delay.
- **Check 51** — the refusal used to blame the individual permission ("enable 'Control mouse and
  keyboard' in the app") even when Read-only was what actually withdrew it, on `computer`,
  `browser`, and Core's `exec_command`/`write_stdin` alike. It now says plainly `TOOL_DISABLED: …
  is disabled because Read-only mode is on … turn Read-only off in the app`. Confirm the new
  wording on at least two of those four tools, not just one.
- **Two UI opinions from the same run, both acted on.** The Read-only button carried no warning
  before activation — it now states, before you toggle it, what turning it on withdraws (file
  changes, commands, browser control, mouse/keyboard, clipboard writes) and what stays available
  (screenshots, reads). And the extension step's red "Required for sub-agents" paragraph used to
  stay red even once the extension was actually connected, next to its own green checkmark — it
  now reads as neutral explanation once connected. Checks 55 and 56 below ask for both.

**This round: your real 49-check run found the last two open items were only half fixed, and
both are now actually fixed rather than just moved.**

- **Check 46 — the false negative was still there, for a different reason.** The previous fix
  made the *timing* right (poll for the position to start changing) but not the *target*: it only
  ever read `window.scrollX`/`scrollY`. A horizontal scroll over a nested `overflow: auto` strip
  moves that element, not the window — your screenshots proved it moving, WIDE 1/2 → 2/3 → 3/4,
  while the reply kept reporting `BROWSER_SCROLL_FAILED` or `moved: false` regardless. The
  position is now read from whichever element the gesture actually hit —
  `document.elementFromPoint` at the scroll's own coordinates, walking up to the nearest one that
  can scroll in either axis — and only falls back to the window when nothing narrower can.
  Re-run the same horizontal case; `moved` should now agree with the screenshot, not contradict it.
- **Check 50 — the transport fix held, the wording didn't.** Disabling Desktop no longer tears
  down the tunnel (that part was already right and still is), but the refusal itself named
  nothing: `"is disabled by the current Chat On Steroids permissions... enable the permission"`.
  Every capability-gated tool that does not pass its own label now defaults to the capability's
  own Settings row name, so this refusal should read `enable "See the screen"` — the capability
  `observe` actually runs behind. The same default reaches every other tool with the same gap,
  not only this one, so a similarly generic refusal anywhere else is worth reporting too.

**Your next run confirmed check 50 and found 45/46 shared one real cause — read all three below
before reporting any of them from memory of last time.**

- **Check 50 is confirmed fixed.** Your run quoted the refusal verbatim: `enable "See the screen"`
  in the app, not the old generic wording. Nothing further to do here unless it regresses.
- **Check 46 — and 45, and half of 33 — had one shared root cause, found by instrumentation
  rather than another blind run, and it is fixed at the source.** A Mac-side investigation
  added `_debug` to the scroll hit test and A/B'd the driven tab foregrounded against
  backgrounded, same point, same element, same call. Foregrounded: 388 ms, `moved: true`,
  correct. Backgrounded: 7275 ms, `moved: false` — and the instant something brought the tab
  back, the strip's `scrollLeft` jumped to *double* the requested distance, both the gesture and
  its own wheel fallback delivered together the moment the tab could actually composite. Chrome
  does not drop the events; it defers them, and the driver was judging the deferred moment.
  `createdTab` shared the cause from a different angle: a link opened from a backgrounded tab
  gets a new tab whose `openerTabId` names whichever tab is actually active, not the one that
  dispatched the click — ten runs, 5/5 correct foregrounded, 0/5 backgrounded, every single time,
  which is why widening `findCreatedTab`'s poll window would never have helped.

  The driver now activates the driven tab — and waits for it to actually report
  `visibilityState: "visible"`, not just for the activation call to resolve — before a scroll or
  a click. Verified directly (not just reasoned about): a new automated check drives the fixture
  with another tab deliberately in front, and it fails on the old code and passes clean on the
  fix. **Re-run 45 and 46 as ordinary checks now** — if your driven tab was ever likely to sit
  behind the conversation tab (the ordinary case, not a rare one), that is exactly the condition
  this closes. If either still fails, that is a real, new finding, not the same one again; keep
  the fixture file this time either way, since two rounds lost it.
- **Check 33's "blank white screenshot / refs no longer reachable" is not explained by this fix**
  and was not chased further this round — the plain page-scroll half of that failure shares the
  same background-tab mechanism above and should be watched for whether it recurs on its own now
  that 45/46 are addressed, but the blank-screenshot/unreachable-refs half needs its own
  reproduction if it happens again.
  `docs/qa/reports/2026-09-02-chatgpt-735c269.md` has the full detail from this round.

Still worth confirming from earlier rounds: typing no longer loses text past a newline (check 7);
a click cannot escape the window it is leased to (check 10); the pointer line names the frame it
was handed (check 37); a missing window is named (check 31); `detach` says what it let go of
(check 25); and `/hello` reports `spoken`, so `compatible: false` on a plain curl is expected
rather than a mismatch.

From the run before that, and still worth confirming: the window title carries the build again and
`/hello` reports it; scrolling goes through a scroll gesture because the wheel event does nothing
in Chrome 152; a window being moved is read a second time; a refused focus names the window in
front; navigate opens a page when none is open; status says where the driver is now; an unreadable
address is refused; a driven tab that lands on a refused page is let go of; the pointer overlay
survives a navigation; and letting go of a tab takes it out of the driven group.

## Rules

- Verify the *effect*, not that the call returned. A tool answering `ok` while nothing moved is
  the failure worth catching, and this product has shipped it twice.
- Quote error codes and messages verbatim.
- Never retry a failed action more than twice.
- Do not skip a section because an earlier one failed.
- In section E use the `browser` tool and nothing else. If something cannot be done with it, that
  is the finding: report FAIL and name the action you looked for and did not find.
- The `browser` tool has no attach action. `navigate` starts a run, taking the newest ordinary tab
  or opening one if the browser has none.
- The `computer` tool takes **one UI-changing action per call** — click, type, key, drag and the
  like. `focus`, `move`, `wait` and the clipboard actions are setup and may go with it. The schema
  says so now; batching two decisions is refused before anything runs.
- If an action would touch this conversation's own tab, stop and report it. That must be refused,
  and a refusal there is a pass.

## A. Screenshots and the mouse pointer

Open TextEdit yourself first — `open -a TextEdit` through the shell tool, and `osascript` if you
need a document in it.

1. Take a **full-screen** screenshot. Confirm you receive an image and state its dimensions.
2. Take a screenshot of one specific window that is not Chat On Steroids, with the pointer moved
   **inside that window** first.
3. Look at the image. **Is the pointer visible?** Yes or no. If yes, is its tip where you moved it?
4. Repeat with the pointer deliberately **outside** that window. It should not appear.
5. Capture a window while a text field is focused, so the pointer is an I-beam. Report whether it
   appears and whether it is centred on the position rather than hanging below-right.

## B. Clicking, typing and control discovery

6. In a blank TextEdit document, list the controls the tools can see. Report how many, and whether
   the document's text area is among them.
7. Click into the document and type `Chat On Steroids QA`, then Enter and a second line. Read the
   document back — through the shell tool if that is easier — and confirm the text arrived exactly.
8. Set a value directly into a text field rather than typing it, and confirm the contents.
9. Find a **disabled** control and try to click it. It must be refused with a named error.
10. Try to click at a coordinate outside every window (5,5) — first with no target window, then
    on the retry with one supplied. **Both must be refused.** The second was not: the click was
    sent, at 5,5, outside the very window it was leased to. It must now answer
    `OUTSIDE_TARGET_WINDOW`, naming that window and its bounds.

## C. Which window is in front

11. With two windows open and overlapping, ask which is foreground and verify against a screenshot.
    Then activate Chat On Steroids yourself (`open -a "Chat On Steroids"`) and ask again: its own
    windows are never exposed, so the answer must say that rather than report an empty desktop.
    Quote it.
12. In Chrome, hover a link until the preview bubble appears, then immediately ask which window is
    foreground. It must be Chrome's real window — not the bubble, not "none".
13. Bring a different app to the front and confirm the answer changes.

## D. Scrolling, dragging, keyboard

14. Scroll a long document down and back up. Confirm from screenshots that it moved both times,
    and quote the `scroll` object from each reply — it says which window received the wheel and
    whether the scroller actually travelled.
15. Drag a **file** in Finder from one place to another and confirm with the shell tool that the
    file actually moved. Use a path with several waypoints, not two — two points is a teleport and
    starts no drag. If you drag selected text instead, press **inside the selection**; pressing
    outside it only moves the caret, which is what made this look broken once before.
16. Send Cmd+A then Cmd+C. Confirm the selection happened and the clipboard holds the text
    (`pbpaste` through the shell tool).
17. Send Escape, Tab and an arrow key. Judge each by its **actual** effect and read it back with
    the shell tool: Tab inserts a tab character, an arrow moves the caret. Do not ask for a
    postcondition the key does not have — Escape closes nothing in TextEdit, and demanding
    `window_closed` is a wrong expectation rather than a failure.

## E. The Chrome extension and browser control

18. `navigate` to `https://example.com`, then `status`. Report the tab, title and URL, and whether
    Chrome had an ordinary tab open beforehand or the tool opened one.
19. `observe`. Report the page title and how many refs came back. Then find a page with a
    checkbox and a text field — a settings or sign-in page does nicely — and `observe` it: a
    checkbox must carry `checked=true` or `checked=false`, a field that holds text must carry
    `value=…`, and a plain text field must carry **no** `checked` at all. Both facts were
    collected since this driver was written and neither was ever printed, so a ticked box looked
    exactly like an empty one; the first attempt at fixing that then printed `checked=false`
    beside every text field, which is the noise this check also guards against.
20. From that same `observe`, confirm you received a screenshot and that the **pointer overlay** is
    drawn — with no mouse action between the navigation and the look.
21. `navigate` to a search engine, click the field, `type` a query, `keypress` Enter, `observe`,
    confirm results loaded.
22. `back`, `forward`, `reload`. After each, `observe` and report the page **title**.
23. `click_ref` an element from your latest `observe` rather than a coordinate. Confirm the effect,
    and quote `hit` and `covered` from the reply whether it worked or not.
24. **The refusals.** `navigate` to `https://chatgpt.com/`, then `chrome://settings`, then
    `file:///etc/hosts`. All three must be refused and the driven tab must survive — check with
    `status`. Quote each error. **Passing means being refused.**
    Then four more, which a review found were **not** refused until yesterday, because the rule
    was a string prefix rather than a parsed address: `http://chatgpt.com/`,
    `https://user@chatgpt.com/`, `https://sub.chatgpt.com/`, and `data:text/html,<p>hi`. All four
    must be refused. And one that must be **allowed**, because it is not ChatGPT and only looks
    like it in the first few letters: `https://chatgpt.com.example.org/` — if that is refused, the
    rule is judging spelling instead of identity, which is the defect in the other direction.
25. `detach`, then `status`. `detach` now names what it let go of — `let go of tab N — title
    (url); no tab is under control` — so quote it and confirm `status` agrees. Do not try to
    prove the overlay is gone: no action reads a tab the tool has released, the last run was
    right to report that as a gap, and the overlay's absence is proven in the driver suite
    against the page itself.

## F. Fixes with no older check

33. **Scroll direction.** `navigate` to a long page, `scroll` with a positive `scroll_y`, `observe`,
    and confirm from the screenshot that the content moved **down**. Then scroll back. This has
    never been judged anywhere — a build machine cannot deliver a wheel event — so this run is the
    first that can.
34. **set_value replaces, and clears.** In a field that already contains text, `set_value` a new
    string; it must contain **only** that. Then `set_value` an empty string and confirm it is
    genuinely empty.
37. **A pointer outside the captured window.** Move the pointer well outside a window and capture
    that window **in the same call**, then read the reported pointer line. It must say the
    pointer is outside the frame rather than print coordinates outside the image — and the frame
    it names must be the picture you were just handed. The last run saw an older frame named
    there, which was true of that frame and about a different image.
39. **A click cannot walk into a refused page.** With a page under control, `navigate` to a page
    you control that links somewhere refused — `data:text/html,<a href="about:blank">go</a>` will
    not do, since data: is refused itself, so use any real page with an `about:blank` link, or
    make one with the shell tool and serve it from `python3 -m http.server`. `click_ref` the link.
    The next browser action must be refused with `BROWSER_URL_REFUSED`, and `status` must report no
    tab under control.
40. **The driven-tab band.** While a tab is under control, `status` must say
    `in driven group <N>`. After `detach` it must say no tab is under control. You do not need to
    look at the tab strip — the group is in the answer.
41. **`move_ref` — the action you asked for twice.** It hovers a control named by ref and presses
    nothing. Find a page with something that only appears under the pointer — a navigation menu
    that opens on hover does nicely — `observe`, `move_ref` its ref, then `observe` again and
    confirm the revealed controls are now in the list. Quote `hit` and `covered` from the reply.
    Then confirm it did **not** click: whatever the control does on click must not have happened.
    Coordinates were never a substitute here, because what a hover reveals is positioned relative
    to the element and the point has to be resolved at the moment of the move.
42. **A drag inside a web page.** Until yesterday the browser drag pressed and released in the
    same instant — no hold, no dwell — so an HTML5 drag never started and a drop target that arms
    on hover never armed. Both desktop drivers have carried those two waits for months; the
    browser one now does too. Find a page with real drag-and-drop (a to-do list that reorders, or
    any HTML5 demo), `observe`, and `drag` along a path of several waypoints from one item to
    another. Confirm from a fresh `observe` that the order actually changed. Two waypoints is a
    teleport and starts no drag — the same rule as the desktop check.

43. **A ref that has gone stale.** `observe`, then `navigate` somewhere else, then `click_ref`
    one of the refs from before. It must be refused by name — `BROWSER_BAD_REF` — rather than
    clicking whatever now happens to sit at those coordinates. Then re-`observe` and confirm the
    fresh refs work. A run met this organically once; it should be a check, not an accident.
44. **Two observations in one call.** Put two `observe` actions in a single `browser` batch with
    an action between them. Only the refs from the *last* one are live, and the answer says so.
    Confirm the earlier block is marked superseded, and confirm a ref from the first block is
    refused if you use it. This rule exists because refs are re-resolved against the newest
    observation, and a caller holding older ones is holding numbers that no longer point anywhere.
45. **A click that opens a second tab.** Find a link with `target="_blank"` and `click_ref` it.
    Report what `status` says afterwards. **This used to be an open gap and now is not**: the
    click's own reply should carry `createdTab: {tabId, url, title}` for the new tab, without you
    needing to list tabs separately or guess. Confirm it is present and correct here, and confirm
    it is **absent** on an ordinary click that opens nothing — the field should not appear where
    there is nothing to report.
46. **Horizontal scroll, and a double click in a page.** On a page with a wide table or a
    horizontally scrolling strip, `scroll` with `scroll_x` and confirm from the screenshot that
    the content moved sideways. Then `double_click` a word in a paragraph and confirm from a
    fresh `observe` or a screenshot that it selected the word rather than clicking twice.
    **If this fails again: do not delete the fixture in cleanup.** Two rounds have now measured
    this exact contradiction — the screenshot moves, the reply still says `BROWSER_SCROLL_FAILED`
    — against two different ad-hoc fixtures, and neither survived to be read afterward. Keep the
    file and quote the exact markup around the coordinate you scrolled at; that is the one piece
    of evidence still missing.
47. **A control inside an iframe.** Find a page with an iframe carrying a real control — a
    payment field, an embedded map, a comment widget — `observe`, and confirm controls from
    inside the frame appear in the refs. Then `click_ref` one and confirm the effect. The driver
    suite proves this against a fixture; nothing has proved it against a real page.
48. **The clipboard in the other direction.** Put text on the clipboard with the desktop tool,
    then paste it into a document with Cmd+V and read the document back with the shell. Every
    earlier check only reads the clipboard; writing it has never been exercised here.
49. **The batching rule, deliberately broken.** Send a `computer` call containing two
    UI-changing actions — two clicks, or a click and a type on different windows. The schema says
    one per call. Confirm the refusal, and confirm it names the rule rather than failing
    obscurely. A run met this as a surprise once, which is what put the sentence in the schema.

## G. Robustness

30. Start a screenshot while the window is being moved. Move it yourself: run a loop in the
    background through the shell tool, for example
    `osascript -e 'tell application "System Events" to tell process "TextEdit" to repeat 40 times
    set position of window 1 to {100, 100} … end repeat'`, or simply nudge it repeatedly, and
    capture during it. The correct answers are a clean stale-frame refusal or, now,
    `WINDOW_MOVING` naming where it went. A screenshot plus `UIA_FAILED` is the old wrong answer
    and worth reporting if you still see it.
31. Ask for a screenshot of a window closed in the meantime. The error must name the missing
    window.
32. Ask for a screenshot with an absurdly large width. It must be clamped or refused.

---

# The report

**Environment** — macOS version, Mac model, Chrome version, and the `build` string from `/hello`.

## H. The settings and the permission step

This surface has never been tested by any run, and it is the first thing a new person sees. All
of it is in the app window, so use screenshots and the desktop tools — do not ask the person
running this to look at anything.

50. **The Desktop capability, off and on.** Open the app's settings. Turn the Desktop capability
    off, then ask for any desktop action through the connector. The refusal must say the
    capability is off and how to turn it on — not a generic failure. Turn it back on and confirm
    the same action now works. Quote both answers.
51. **Read only.** Switch Read Only on. Confirm a screenshot still works and a click does not,
    and that the refusal names read-only as the reason rather than naming permissions. This
    ordering matters: read-only withdraws control, so a refusal that blames a missing permission
    would send someone to System Settings for no reason.
52. **The permission rows.** With Screen Recording and Accessibility both granted, screenshot the
    settings pane and describe each row: what it says, whether a button is offered, and whether
    any restart note appears. Then, if you can do it without locking yourself out, revoke one in
    System Settings, return to the app, and confirm the row changes **without** a restart — the
    app re-reads permissions live, and a row that lies here is worse than no row, because a
    person acts on it.
53. **The browser-control toggle.** Turn browser control off in the extension popup and confirm a
    `browser` action is refused with a message naming the popup. Turn it on again and confirm it
    recovers. Report whether the wording tells you *where* to click, not only that something is
    off.
54. **What the settings look like.** Screenshot the whole settings surface and describe it as a
    person would see it: is it obvious which switches matter, does anything overlap or clip at
    the default window size, is any label ambiguous. This is a judgement, not a pass/fail — say
    what you would change and why. Aesthetic and clarity problems here have never been reported
    by anyone, which is not the same as their absence.
55. **Read-only's warning, before you switch it on.** Screenshot the Read-only button and its
    immediate surroundings **before** turning it on. The app must now say, in that screenshot —
    not only in a refusal afterwards — what turning it on withdraws (file changes, commands,
    browser control, mouse/keyboard input, clipboard writes) and what stays available (screenshots,
    reads). A tooltip alone does not satisfy this; confirm there is visible text, not only a hover
    hint a screenshot cannot show.
56. **The extension step's colour, once actually connected.** With the Chrome extension loaded and
    connected, screenshot the "Add the Chrome extension" step. The "Required for sub-agents"
    paragraph must not sit in warning red beside its own green checkmark and "Connected." — confirm
    it now reads as neutral explanation rather than an outstanding warning. Then, if convenient,
    disconnect the extension and confirm the same paragraph turns red again — the colour should
    track the real state, not disappear along with the check.

**Summary** — how many of the 49 checks passed, failed, or could not be run, and the three most
serious problems in one line each.

**Check by check** — number, PASS / FAIL / NOT PERFORMABLE, whether it differs from the previous
run, and one or two sentences of what happened. Verbatim error text for failures.

**The pointer questions** — is the pointer visible in a window screenshot; is it at the right
position; is the I-beam correct; does it stay absent when outside the window.

**Anything unasked** — anything wrong, slow, confusing or dangerous that no check covers. On five
runs this has been the most valuable section. In particular: did any check make you want an action
a tool does not have?
