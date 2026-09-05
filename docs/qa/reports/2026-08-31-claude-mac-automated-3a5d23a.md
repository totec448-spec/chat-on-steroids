# Claude on Mac — automated run against `3a5d23a`, 2026-08-31

Source: `docs/qa/claude-on-mac-start-here.md`. Branch `integrate/browser-and-desktop-064733`
at `3a5d23a`, working tree clean. Second automated run on this machine; the first is
`2026-08-31-claude-mac-automated.md` and was against `2164930`.

Machine: macOS 27.0 (26A5421a), arm64. Swift 6.4. Node 22.23.2. Screen Recording and
Accessibility granted to `Terminal.app`, so the TCC-gated paths actually execute.

**Headline: the three listed steps all pass, and the probe's foreground check did not judge
anything in 4 of 4 runs. The reason it had nothing to judge is itself a defect — section 4.**

## 1. `npm run verify:ci` — PASS

`package.json` and `package-lock.json` are unchanged since the previous run, so the existing
`npm ci` tree is still valid and was reused.

```
Public-history privacy check passed
tsc --noEmit -p tsconfig.json      (clean)

 Test Files  73 passed | 3 skipped (76)
      Tests  1847 passed | 97 skipped (1944)

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

Exit code 0.

**On the counts.** The hand-off says Windows gives `1922 passed, 22 skipped`. macOS gives
`1847 + 2 = 1849 passed, 97 skipped`. The **total is 1944 on both**, so this is platform gating,
not a missing test. Nothing that ran, failed. Same relationship as the previous run (1932 both
sides).

## 2. `npm run verify:browser` — 23/23

Run with **no `COS_BROWSER`**: Chrome for Testing 152.0.7977.64 now lives at
`/Applications/Chrome for Testing.app`, which is already first in the script's macOS candidate
list, so the harness finds it unaided.

```
23/23 checks passed
```

## 3. Helper build and probe — PASS, `pointer=drawn captureMode=window`

`node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch arm64`:

```
  SOLINK_MODULE(target) Release/macos_desktop_addon.node
gyp info ok
macOS arm64 desktop helper, in-process library and Node addon built and verified.
```

`node scripts/probe-macos-helper.mjs arm64`, four runs, all exit 0 and all
`pointer=drawn captureMode=window`.

The pixel comparison concluded in **one run of four**:

```
image 640x412, 99 pixels differ, box {"x":316,"y":196,"width":8,"height":20}
pointer was expected near 320,206
PIXELS CONFIRM the pointer is drawn, at the position it was moved to
```

An 8x20 box at 316,196 against an expected 320,206 is a pointer glyph on the addressed pixel.
That is the hand-composited path proven in the pixels.

The other three runs ended:

```
the window redrew between captures, so position could not be judged
```

with diff boxes of 316x207, 122x182 and 315x207 — over the `width/3` localisation threshold. The
painting wait added in `414f0c7` improved this (it was 0 of 2 before, 1 of 4 now) but has not
removed it. Not a defect in the product; a limit on how often the probe's strongest assertion
actually fires.

## 4. DEFECT — the helper goes permanently blind to applications started after its first query

### What the probe reported

In **4 of 4** runs:

```
ok    it names a foreground window — ok
      foreground=0, opened window 1267, window list claims none
      no window claims foreground on this runner, so there is nothing to judge
```

The probe passes on that. But this is a real desktop, not a runner, and in the *same run* the
cursor op disagreed with it:

```
cursor={"x":1123,"y":60} foreground=731     <- cursor op names a foreground window
foreground=0 ... window list claims none    <- the foreground check does not
```

### Reproduction

Two helper processes, same desktop, same moment. One had made a query **before** TextEdit was
launched; the other was started **after**.

```
H1 gestartet, fragt VOR dem Öffnen ab:
  H1 vorher                          fg=1190   claims=1 ["Chat On Steroids 2.0.2-a"]

TextEdit ist jetzt offen und vorne:
  H1 (hat vorher abgefragt)          fg=0      claims=0 []
  H2 (frisch gestartet)              fg=1389   claims=1 ["fg-cache.txt"]

Gegenprobe - H1 nochmal, und H2 nochmal:
  H1 zweiter Versuch                 fg=0      claims=0 []
  H2 zweiter Versuch                 fg=1389   claims=1 ["fg-cache.txt"]
```

H1 is blind and stays blind. H2 is correct and stays correct. Reproduced 3 of 3 times with a
query-then-launch sequence, and the blindness clears the moment TextEdit quits — the helper
returns to naming `Chat On Steroids`, which existed when it took its first snapshot.

The script that produces the table above:

```js
// start two helpers; query H1 first, then launch TextEdit, then query both.
const start = () => spawn('resources/packaging/desktop/darwin/arm64/macos-desktop-helper', [],
  { stdio: ['pipe', 'pipe', 'ignore'] });          // + newline-delimited JSON on stdin/stdout
// H1: {op:'cursor'}, {op:'windows'}               -> takes its snapshot here
// open -a TextEdit <file>; wait 6s
// H1: {op:'cursor'}, {op:'windows'}               -> fg=0, no window claims foreground
// H2 (started now): same two ops                  -> correct
```

### Mechanism

One line, and the only `NSWorkspace` use in the helper:

```swift
private func frontmostPID() -> pid_t? {                       // main.swift:242
    NSWorkspace.shared.frontmostApplication?.processIdentifier
}
```

`NSWorkspace.shared.frontmostApplication` is served from an internal running-applications cache
kept current by notifications delivered on a Cocoa run loop. The helper is a stdin/stdout
command-line process and never runs one, so its view is fixed at first access and applications
launched afterwards never enter it.

This matches every observation: window **enumeration** goes through
`CGWindowListCopyWindowInfo` and is fresh — the probe found and captured TextEdit's window
(`window 1267 "cos-probe-window.txt" at 214,112 656x422`) without trouble — while foreground
**attribution** goes through `NSWorkspace` and is stale. Hence a listed, capturable, visibly
frontmost window that no code will call foreground.

Stated as mechanism, not as proof: it is consistent with all the evidence above, but it was
**not** confirmed by patching `frontmostPID` and re-running. Nothing here was changed.

### Why it matters

The app runs **one long-lived helper**. After its first window query, every application the user
subsequently launches is invisible to foreground resolution for the life of that process. That is
`No foreground window` while an app is plainly frontmost — the symptom the release was held for.

This is distinct from the case fixed in `a5565df`. That one was z-order versus AX focus inside an
already-running Chrome, and this reproduction involves no transient child window at all: a plain
TextEdit document window is enough. Two independent causes, one symptom.

### Why the probe did not catch it

`414f0c7` made the foreground assertion conditional: with no window claiming foreground there is
nothing to judge, so the probe says so and passes. That reasoning is right for a CI runner with
no user session. On a real desktop it converts the defect into the condition for skipping the
check that exists to find it. In 4 of 4 runs here the assertion never executed.

## Still untested — unchanged by this run

- The onboarding permission step on screen: timing, deep-link targets, live refresh, both
  themes. `951e746` and later commits add unit tests; the on-screen behaviour is **untested**.
- QA cases 6.9, 6.3, 6.2, 6.4 — **untested**.
- Runbook §3 Test 5 against Chrome's link-preview bubble through the **app** — **untested here**.
  Section 4 above reaches the same symptom by a different and simpler route, through the helper
  directly, and does not substitute for it.
- `docs/qa/chatgpt-desktop-qa-prompt.md`, the 32-check model → MCP → app → macOS script —
  **not run**.
