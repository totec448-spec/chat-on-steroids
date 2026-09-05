# macOS QA runbook

Everything in this repository that can be checked without a Mac has been. `verify:ci` is green
(1910 passed, 22 skipped), the browser driver scores 23/23 against real Chrome 152 and against
Edge, and all six release platforms build. What is left needs a physical Mac, a real pointer at
a real position, and macOS's own permission dialogs. That is this list.

Written so a session with no history of the work can run it.

## What you are testing

Build `e148ad1`, artifact `package-macos-arm64` (or `-x64` on Intel), from workflow run
`33363059380`. Verify before installing:

```sh
shasum -a 256 Chat-On-Steroids-macOS-arm64.dmg
# 19236e77fc5cafee1868e50ca57889f1136c5ef32dad42bcf27d051b96bfd837
```

## Reading the log

Three of the checks below are decided by a log line, not by looking at a picture. The app has an
**Activity** panel; every line quoted here appears there. No terminal needed.

If you would rather watch it from a terminal, the app only echoes to stderr when asked:

```sh
CLF_DEBUG=1 "/Applications/Chat On Steroids.app/Contents/MacOS/Chat On Steroids" 2>&1 \
  | grep --line-buffered "desktop timing"
```

## 1. The pointer in a window screenshot

This is the one that was reported wrong before, and the one prior claims about were wrong about.

**Status, 2026-08-31:** the hand-composited path has now been run and the picture inspected —
`pointer=drawn captureMode=window`, glyph centred on the addressed pixel, in
`docs/qa/reports/2026-08-31-claude-mac-automated.md`. That was through
`scripts/probe-macos-helper.mjs` against a Terminal window. The steps below drive the same code
through the **app**, which additionally covers its TCC handling and its Activity logging, so they
are still worth doing — but you are no longer looking for a first answer, you are confirming one.
`SCStreamConfiguration.showsCursor` cannot reach a desktop-independent window filter, so for
window captures the pointer is composited by hand at its hotspot; display captures get the
system's own. An absent pointer used to look identical whichever cause produced it, so each
cause now names itself.

1. Grant Screen Recording, then fully quit and reopen the app (macOS caches a TCC answer for the
   life of the process — this is why the step says so on screen).
2. Put the pointer **over** a window that is not Chat On Steroids.
3. Ask for a screenshot of that window.

Then read one line in Activity:

```
desktop timing screenshot_read_ms=… screenshot_base64_ms=… screenshot_bytes=… pointer=…
```

| `pointer=` | means | verdict |
|---|---|---|
| `drawn` | composited at the hotspot | **pass** — the arrow must be visible in the image, tip on the addressed pixel |
| `system` | ScreenCaptureKit drew it (display/composite capture) | pass, but you captured a screen, not a window — retry against a window |
| `unavailable` | `NSCursor.currentSystem` gave nothing | **known open risk**, see below |
| `outside_region` | the pointer was not over the captured window | not a defect — move the pointer and repeat |
| `buffer_unavailable` | the bitmap context failed | defect, report it |
| `unreported` | an older helper | you are not on `e148ad1` |

**If it says `unavailable`:** that is the open design question, not a surprise. The code refuses
to invent a pointer, because a fabricated one in a screenshot is worse than none — a coordinate
would be read off it. The alternative is falling back to the standard arrow: position stays
exact, shape may be wrong, and a genuinely hidden cursor (video playback) would show one that is
not there. Note which app was frontmost when it happened; the choice is yours to make.

## 2. The permission step in onboarding

Rows were measured in a browser against the shipped stylesheet; the action buttons failed WCAG AA
(3.12:1 on amber, 3.03:1 on red) and now sit at 5.47:1 / 5.78:1 in light and 8.67:1 / 7.31:1 in
dark. What could not be checked off a Mac is whether the step appears at the right moment and
whether the deep links open the right pane.

- The step shows only on macOS, and only when screen or control capability is on.
- Each **Open …** button must land on that exact System Settings pane, not the top level.
- Grant one permission and return **without** restarting: the list must update on its own, and
  the amber restart note must remain.
- Fully quit and reopen: the granted row turns green and loses its button.
- Both themes.

## 3. The QA cases still outstanding

From the previous report, unchanged in scope: **6.9, 6.3, 6.2, 6.4**, plus **Test 5** — Chrome's
link-preview bubble and foreground-window resolution. Test 5 has a specific shape: hover a link
in Chrome until the preview bubble appears, then ask which window is in front. The answer must be
Chrome's real window, not the bubble.

## 4. Browser control, on this platform

The driver is proven on Windows against Chrome 152 and Edge (`npm run verify:browser`, 23/23),
and now on macOS against Chrome for Testing 152 (23/23 — see
`docs/qa/reports/2026-08-31-claude-mac-automated.md`). The same script runs here and finds
Chrome, Chrome for Testing or Edge at the usual paths:

```sh
npm run verify:browser
```

Chrome 137 and later ignore `--load-extension`, so installed Chrome cannot be driven this way —
the script prefers a Chrome for Testing build and says so plainly if the extension did not load.
This is a harness limitation only: users install through **Load unpacked**, which still works.

## 5. When a tool seems to be missing

The QA run found the Desktop connector offering only `observe` and `computer`, with no `browser`,
and could not tell whether the app fails to publish it or ChatGPT is holding an old tool list.
The app already answers that. In the app: **Home** → the **Health** card → **Run checks**. Two
lines in the result matter. **Build** names the commit this app was built from, which is the only
way to tell two builds apart — they all call themselves 2.0.2, and a QA run was once spent on an
app that predated the feature it was testing. **Local server** names every tool actually served:

```
Answers on loopback and offers 3 tools: browser, computer, observe
```

If `browser` is in that line, the app is serving it and ChatGPT is looking at an older list: a
chat keeps the tool list it loaded, so start a **new chat** first, and only recreate the
connector if that still does not show it. If `browser` is absent,
`control` is not switched on for this connector: check that **See and use the desktop** is on and
that **Read only** is off, since read-only strips control while leaving screenshots.

## Reporting back

For each item: what you did, what you saw, and for section 1 the exact `pointer=` value. A
screenshot of a failure is worth more than a description of it — except where the log line is
the evidence, in which case quote the line.
