# Claude on Mac — automated run, 2026-08-31

Source: `docs/qa/claude-on-mac-start-here.md`, branch `integrate/browser-and-desktop-064733`,
at commit `2164930` (working tree otherwise clean at the start of the run).

Machine: macOS 27.0 (build 26A5421a), arm64, Apple silicon. Swift 6.4
(`swiftlang-6.4.0.33.1`), Command Line Tools at `/Library/Developer/CommandLineTools`.

## 0. Toolchain — a finding before the list started

The machine had **no Node and no Homebrew**. `node`, `npm`, `nvm`, `volta`, `fnm`, `mise` and
`asdf` were all absent, and there is no `/opt/homebrew` or `/usr/local/Cellar`. Nothing in
sections 1–3 can run without Node 22 (`.github/workflows/ci.yml` pins `node-version: 22`).

Resolved by unpacking the official tarball, not by a package manager:

```
node-v22.23.2-darwin-arm64.tar.gz: OK      (shasum -a 256 -c against nodejs.org SHASUMS256.txt)
installed to ~/.local/node-v22.23.2
v22.23.2
10.9.8
```

Nothing was written to `/usr/local` or `/opt`. Removing `~/.local/node-v22.23.2` undoes it.

## 1. `npm ci`, then `npm run verify:ci` — PASS

`npm ci`:

```
added 426 packages, and audited 427 packages in 3s
found 0 vulnerabilities
```

`npm run verify:ci`:

```
> chat-on-steroids@2.0.2 rg
> node scripts/fetch-ripgrep.mjs

ripgrep 15.2.0 darwin-arm64 checksum ok (3750b2e93f37e0c6...)
ripgrep 15.2.0 darwin-arm64 staged
resources/rg mirrors darwin-arm64 for development

> chat-on-steroids@2.0.2 verify:privacy
> node scripts/verify-public-history.mjs

Public-history privacy check passed (64 commits, 3 tags).

> chat-on-steroids@2.0.2 typecheck
> tsc --noEmit -p tsconfig.json


 RUN  v4.1.10 <repo>


 Test Files  73 passed | 3 skipped (76)
      Tests  1835 passed | 97 skipped (1932)
   Start at  11:15:15
   Duration  19.48s (transform 5.31s, setup 0ms, import 53.63s, tests 48.24s, environment 3ms)


 RUN  v4.1.10 <repo>


 Test Files  1 passed (1)
      Tests  2 passed (2)
   Start at  11:15:35
   Duration  5.55s (transform 277ms, setup 0ms, import 411ms, tests 5.08s, environment 0ms)
```

Exit code 0. Nothing failed.

**Note on the counts.** The hand-off says Windows gives 1910 passed / 22 skipped. macOS gives
1837 passed / 97 skipped. The **total is 1932 on both**, so this is platform gating, not a
missing or broken test: 75 tests that run on Windows are skipped here. No test that ran, failed.

## 2. `npm run verify:browser` — 23/23, after fixing a macOS-only harness bug

### First run — 0/2, with a misleading reason

`COS_BROWSER` pointed at a freshly downloaded Chrome for Testing 152.0.7977.64 (mac-arm64,
no quarantine xattr). Installed Chrome on this machine is 152.0.7977.65.

```
> chat-on-steroids@2.0.2 verify:browser
> node scripts/verify-browser-driver.mjs

FAIL  the extension loads and its popup resolves  — /private/tmp/.../chrome-mac-arm64/Google Chrome
FAIL  the run completed  — the extension was not loaded. Chrome 137 and later ignore --load-extension; use a Chrome for Testing build, or point COS_BROWSER at Edge.

0/2 checks passed
```

That message is wrong on macOS, and it was worth not believing. Launching the same binary by
hand with the same flags and listing the CDP targets:

```
path.resolve  : /var/folders/2r/.../T/extid-22725/extension          => id leocbpnabnaodoofjhoomofbmkhgjcek
realpathSync  : /private/var/folders/2r/.../T/extid-22725/extension  => id cienbmpeoehghbpemdjcmjbhlefgbmog
browser: Chrome/152.0.7977.64
--- all targets:
 [browser_ui] chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html
 [page] about:blank
 [browser_ui] chrome://webui-toolbar.top-chrome/
 [browser_ui] chrome://omnibox-popup.top-chrome/
 [service_worker] chrome-extension://nkeimhogjdpnpccoofpliimaahmaaome/thunk.js
 [service_worker] chrome-extension://glbjnfimcajjenihimblfaponejbkoph/background.js
 [service_worker] chrome-extension://cienbmpeoehghbpemdjcmjbhlefgbmog/background.js
```

The extension **does** load under Chrome for Testing 152 on macOS. It loads under the
`realpathSync` id. `scripts/verify-browser-driver.mjs` derived the id from `path.resolve(copy)`,
but Chromium hashes the symlink-resolved path — and on macOS `os.tmpdir()` is
`/var/folders/…`, a symlink to `/private/var/folders/…`. The harness therefore asked for a popup
at an id no target ever carried, got the chrome-error page that keeps the requested url, read
`chrome.runtime.id === null`, and reported Chrome's `--load-extension` removal as the cause.

Windows has no such symlink, which is why 23/23 there never exposed it.

Fixed by resolving the path on non-Windows only, leaving the proven-green Windows arithmetic
untouched.

### After the fix — 23/23

```
PASS  the extension loads and its popup resolves  — chrome-extension://fgjoanmclohifbgongadpnpjickgaldn/popup.html
PASS  the fixture page is open  — http://127.0.0.1:9997/
PASS  the extension can see the page tab
PASS  the driver attaches over the DevTools protocol  — {"attached":true,"tabId":1901711707,"url":"http://127.0.0.1:9997/","title":"Driver fixture"}
PASS  observe reads the page  — Driver fixture
PASS  finds the main-frame controls  — Run the thing | Your name | Double me | Go onward | Inside the frame
PASS  finds the control inside the iframe  — Run the thing | Your name | Double me | Go onward | Inside the frame
PASS  omits what a pointer cannot reach  — Run the thing | Your name | Double me | Go onward | Inside the frame
PASS  one screenshot pixel is one CSS pixel  — {"shot":{"w":756,"h":413},"viewport":{"width":756,"height":413}}
PASS  the page received a TRUSTED click  — clicked trusted=true
PASS  the field fired real input events  — typed:Maxim
PASS  the iframe received a TRUSTED click  — inner clicked trusted=true
PASS  the pointer overlay is drawn in the page
PASS  a keypress arrives as a TRUSTED key event  — key:Enter trusted=true
PASS  double_click produces a real dblclick  — dblclick trusted=true
PASS  a drag presses, moves while held, then releases  — down:true move:true up:true
PASS  navigate loads the requested document  — Second document
PASS  back returns the previous document  — Driver fixture
PASS  forward goes onward again  — Second document
PASS  reload keeps the same document  — Driver fixture
PASS  an unknown ref is refused rather than guessed  — BROWSER_BAD_REF: e999 is not from the most recent observation of this page
PASS  detach gives the tab back  — {"attached":false,"tabId":null,"url":null,"title":null}
PASS  detach removes the overlay

23/23 checks passed
```

`npm run typecheck` and `npm run verify:privacy` both still pass after the change.

Chrome for Testing 152.0.7977.64 is now installed at `/Applications/Chrome for Testing.app`,
which is already first in the script's candidate list on macOS. **`npm run verify:browser` needs
no `COS_BROWSER` on this machine** — it finds that build on its own and scores 23/23. Installed
Chrome (152.0.7977.65) is still unusable for this harness, as the script says.

## 3. The macOS desktop helper — built, ran, but did NOT reach the pointer path

`node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch arm64`:

```
  CXX(target) Release/obj.target/macos_desktop_addon/addon.o
  SOLINK_MODULE(target) Release/macos_desktop_addon.node
gyp info ok
macOS arm64 desktop helper, in-process library and Node addon built and verified.
```

`node scripts/probe-macos-helper.mjs arm64`:

```
ok    the helper starts and answers — ok
      screenPermission=false accessibilityPermission=false
ok    it can be asked for the cursor — ok
      cursor={"x":1140,"y":492} foreground=599
ok    it can enumerate windows — ok
ok    a capture either works or is refused by name — refused SCREEN_PERMISSION_REQUIRED
      refused: SCREEN_PERMISSION_REQUIRED — enable Screen Recording for Chat On Steroids, then fully quit and reopen the app
ok    it lists windows to capture — ok
      10 windows listed, 10 not minimized
      window 599 "Terminal window" at 982,202 580x385
ok    it can put the pointer inside that window — refused ACCESSIBILITY_PERMISSION_REQUIRED
      pointer could not be moved (ACCESSIBILITY_PERMISSION_REQUIRED) — act requires Accessibility, which a runner rarely grants, so expect outside_region below
ok    it captures that window — refused SCREEN_PERMISSION_REQUIRED

macOS helper probe passed (7 answers)
```

### First attempt: the pointer compositor was not reached

`screenPermission=false accessibilityPermission=false`. Both captures were refused at the
permission gate before any pixels were touched, so **no `pointer=` value was produced** and
`captureMode` reached neither `window` nor `screen`. The probe passed on its own terms, because
a cleanly named TCC refusal is the working path it checks for.

The cause was TCC attribution, not the code. macOS attributes the grant to the GUI ancestor of
the process tree, which for a `claude` session in a terminal is `Terminal.app`:

```
zsh -> claude -> zsh -> login -> Terminal.app -> launchd
```

### Second attempt, with Terminal granted both permissions — PASS

`Terminal.app` was given Screen Recording and Accessibility and fully restarted.

```
ok    the helper starts and answers — ok
      screenPermission=true accessibilityPermission=true
ok    it can be asked for the cursor — ok
      cursor={"x":1652,"y":159} foreground=731
ok    it can enumerate windows — ok
ok    a capture either works or is refused by name — ok
      pointer=system captureMode=screen
ok    it lists windows to capture — ok
      9 windows listed, 9 not minimized
      window 731 "chat_qa — ◑ integrate/browser-and-deskto" at 498,142 1287x805
ok    it can put the pointer inside that window — ok
ok    it captures that window — ok
      pointer=outside_region captureMode=window
FAIL  window capture returned pointer=outside_region with the pointer moved inside it

macOS helper probe FAILED
```

That first run reported `outside_region` and exited 1. **It did not reproduce.** Eleven
consecutive re-runs, same machine, same window 731, same geometry, all reported:

```
pointer=drawn captureMode=window
macOS helper probe passed (7 answers)
```

11/11. The single `outside_region` occurred while a person was physically at the machine
immediately after restarting Terminal. The probe warps the pointer to the window centre and then
captures; any real mouse movement in between makes `outside_region` the honest answer. That is
the most likely explanation, but it is **not proven** — see the open point below.

### The composited pointer, verified in the image and not merely by its verdict

`pointer=drawn` is only a pass if the pointer is actually in the picture at the addressed pixel,
so the PNG was measured rather than trusted.

Window 731 is 1287x805 at 498,142; the pointer was warped to its centre, 1142,545; the capture
is scaled to 640x400, so the addressed pixel is (320,200) in the image. Bright-pixel row profile
around that point:

```
y=196  x 318..322     top serif
y=197  x 319..321
y=200  x 319..321     stem
y=201  x 319..321
y=203  x 319..321
y=204  x 318..322     bottom serif
(y=216..219 is the next line of terminal text, not the cursor)
```

Glyph centre **(320,200) — the addressed pixel, to within a pixel.**

Two things worth stating, because both are what the earlier wrong claim got wrong:

- The shape drawn is an **I-beam**, not an arrow. That is correct: the pointer was over Terminal's
  text area, so the I-beam is the real `NSCursor.currentSystem`. The compositor drew what was
  actually there rather than a stock arrow.
- Its size, ~5x9 px in a 0.497 downscale, is ~10x18 px native — an ordinary I-beam, so it is
  being composited at the capture's scale rather than at raw backing-store pixels.

**The hand-composited window-capture pointer path works on this machine.** This is the code that
was once declared fixed on the strength of correct-looking code and was not; it has now been run,
and the image was inspected.

The capture is at `$TMPDIR/cos-probe-window.png`. It is deliberately **not** committed: it is a
screenshot of a live desktop in a public repository. The row profile above is the evidence.

**Since this run, the probe checks the pixels itself** (`d0916ac`): it captures the window twice,
once with the pointer at the centre and once with it parked at 4,4, and diffs the two through
`scripts/lib/read-png.mjs`. That is a stronger check than the measurement above and it supersedes
it. One observation from running the rebased probe here: against a live TextEdit window it
reported

```
image 640x412, 325 pixels differ, box {"x":9,"y":9,"width":315,"height":207}
pointer was expected near 320,206
the window redrew between captures, so position could not be judged
```

— inconclusive rather than confirmed, because the diff box exceeded a third of the frame. That is
the check refusing to claim a pass from noise, which is right, but it means on a busy desktop the
pixel confirmation may not conclude. The manual measurement above did conclude, on a window that
was not redrawing. Both were `pointer=drawn captureMode=window`.

## Open point — the probe can fail for a reason that is not a defect

`scripts/probe-macos-helper.mjs` treats `pointer=outside_region` as a hard FAIL whenever the
`move` succeeded. But the runbook's own table lists `outside_region` as *"not a defect — move the
pointer and repeat"*. Between the warp and the capture the probe never re-reads the cursor, so a
person brushing the trackpad turns a good build red with a message that names the compositor.

Not changed here. Worth deciding: re-read the cursor after the warp and, if it has left the
window, report the run as inconclusive rather than failed.

## Still outstanding — untested, not passed

- The pointer in a window screenshot (runbook §1) — **PASSED**, see above, verified in the image.
- The onboarding permission step: timing, deep-link targets, live refresh, both themes
  (runbook §2) — **untested**, needs a real desktop and the app itself.
- QA cases 6.9, 6.3, 6.2, 6.4 (runbook §3) — **untested** here.
- Test 5, Chrome's link-preview bubble versus foreground-window resolution — **not untested: it
  FAILS**, on a stale build. See the cross-check below.
- `docs/qa/chatgpt-desktop-qa-prompt.md`, the 32-check model → MCP → app → macOS script —
  **not run**; it cannot be driven from a terminal session.

Note that §1 was exercised here through the **probe**, against a Terminal window. The runbook's
own procedure drives it through the installed app and its Activity panel, which additionally
covers the app's TCC handling and its logging. That variant is still unrun.

## Cross-check against the release report in this folder

`chat-on-steroids-release-qa-5709d323.md` landed in this folder during the same session. It is a
full release pass against the **installed app**, and it recommends **HOLD** on one remaining
release blocker: `Test 5 — Foreground-Window Freshness, FAIL — P2`. Chrome's link-preview bubble
and its omnibox popup leave Desktop reporting `No foreground window` while Chrome is plainly
frontmost, and legitimate actions are then blocked with `FOCUS_FAILED`.

That report's own status block gives the build it tested: `5709d323`, verified by comparing the
installed bundle byte-for-byte against the SHA-named DMG. Placing that commit in this branch:

```
5709d323  Sun Aug 30 22:05:55 2026  Let a settable value speak for a control with no AXEnabled
a5565df   Sun Aug 30 23:38:03 2026  Resolve one app's transient child windows, and draw the
                                    pointer everywhere
```

`5709d323` is an **ancestor** of `a5565df`, and of this branch's head — 34 commits behind it. So
the tested build predates `a5565df` by 93 minutes, and `a5565df` is a fix for precisely this
defect. It describes the same evidence the report gathered independently: the link-preview bubble
at **175x22 at the screen edge** (the report logs `bounds: -1,1014 175x22`), the omnibox popup
after it, `foregroundWindowID` reading a transient child above the focused window as an app
transition in flight and exposing nothing, and `focusWindow` then polling for a condition it
could not satisfy until the bubble went away — which is the `FOCUS_FAILED` the report hit.

**This does not mean the P2 is fixed.** It means the HOLD is recorded against a build that could
not have contained its own fix, so the finding cannot be actioned as it stands, and the fix has
never been exercised against the app on this machine. Deciding otherwise from the commit message
would be the precise mistake this folder's README warns about — the pointer path was declared
fixed once on the strength of code that read correctly.

What would settle it: build from this branch's head, install, and re-run that report's §9.2
Fall A and Fall B — hover a link until the bubble appears, then ask which window is in front,
and repeat with the omnibox popup open. Runbook §3's Test 5 is the same check.

Nothing in the automated work recorded above touches that code path. The two script changes are
harness-only and the helper probe exercises capture and the pointer compositor, not
foreground-window resolution.

## Documentation drift noticed

`docs/macos-qa-runbook.md` §4 still says the browser driver scores 16/16. The script asserts 23
checks, and the hand-off in `docs/qa/claude-on-mac-start-here.md` says 23. Not corrected here.
