import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_SCRIPT } from '../src/main/computer/helper.js';

describe('desktop helper overhaul contract', () => {
  it('does not reintroduce the fixed focus and per-action sleeps', () => {
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 120');
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 30');
    expect(HELPER_SCRIPT).not.toContain('Start-Sleep -Milliseconds 20');
    expect(HELPER_SCRIPT).toContain('Stopwatch]::StartNew()');
  });

  it('keeps observation coalesced and window capture background-first', () => {
    expect(HELPER_SCRIPT).toContain("'snapshot'");
    expect(HELPER_SCRIPT).toContain('CaptureWindow');
    expect(HELPER_SCRIPT).toContain("$mode = 'window'");
    expect(HELPER_SCRIPT).not.toContain('$root.FindAll(');
    expect(HELPER_SCRIPT).toContain('TreeWalker]::ControlViewWalker');
    expect(HELPER_SCRIPT).toContain('System.Windows.Automation.CacheRequest');
  });

  it('returns exact partial-batch evidence and snapshot-scopes UI handles', () => {
    expect(HELPER_SCRIPT).toContain('completed_count = $completed');
    expect(HELPER_SCRIPT).toContain('failed_index = $index');
    expect(HELPER_SCRIPT).toContain('$script:UiSnapshots');
    expect(HELPER_SCRIPT).toContain('STALE_UI_SNAPSHOT');
  });

  /**
   * The pointer belongs in the picture, on both platforms.
   *
   * ScreenCaptureKit composites it for us on macOS (`showsCursor`), but neither
   * `CopyFromScreen` nor `PrintWindow` does on Windows, so the model could not see where the
   * pointer was, read a hover state, or confirm from the image that a move landed.
   *
   * Verified for real on Windows rather than only asserted here: capturing a 64x64 region
   * centred on the reported pointer position through `Clf.Capture` differs from a plain
   * `CopyFromScreen` of the same region in 126 pixels, and the changed region's bounding box
   * begins exactly at the reported pointer pixel and extends right and down — an arrow drawn
   * at its hotspot rather than at the icon origin.
   */
  it('composites the live pointer into both Windows capture paths', () => {
    expect(HELPER_SCRIPT).toContain('static void PaintCursor(Graphics g, int originX, int originY, int w, int h)');
    expect(HELPER_SCRIPT).toContain('GetCursorInfo');
    expect(HELPER_SCRIPT).toContain('DrawIconEx');
    // Screen and window capture both paint, each against its own origin.
    expect(HELPER_SCRIPT).toMatch(/CopyFromScreen\([\s\S]{0,120}PaintCursor\(g, x, y, w, h\)/);
    expect(HELPER_SCRIPT).toMatch(/PrintWindow\(h, dc, 2\)[\s\S]{0,400}PaintCursor\(g, r\.Left, r\.Top, w, height\)/);
    // Drawn at the hotspot: the pixel the pointer actually addresses.
    expect(HELPER_SCRIPT).toContain('int x = ci.ptScreenPos.X - originX - info.xHotspot;');
    expect(HELPER_SCRIPT).toContain('int y = ci.ptScreenPos.Y - originY - info.yHotspot;');
    // A hidden pointer must never be invented into the picture.
    expect(HELPER_SCRIPT).toContain('if ((ci.flags & 0x00000001) == 0 || ci.hCursor == IntPtr.Zero) return;');
    // GetIconInfo hands over two bitmap copies; the cursor handle itself is shared.
    expect(HELPER_SCRIPT).toContain('if (info.hbmMask != IntPtr.Zero) DeleteObject(info.hbmMask);');
    expect(HELPER_SCRIPT).toContain('if (info.hbmColor != IntPtr.Zero) DeleteObject(info.hbmColor);');
  });

  /**
   * Back and forward, the two buttons a browser actually navigates with.
   *
   * They are one event pair told apart by a data word rather than by their own flags, which
   * is why the flags helper had to start carrying it. Posted as real side-button events on
   * both platforms rather than as synthetic Alt+Arrow shortcuts: a shortcut goes to whatever
   * happens to be focused, a button goes to the window under the pointer.
   *
   * Verified against the compiled helper on Windows: left 0x0002/0x0004, right 0x0008/0x0010
   * and middle 0x0020/0x0040 all still carry data 0, back and forward both post XDOWN 0x0080
   * and XUP 0x0100 with XBUTTON1 and XBUTTON2, and an unknown name still falls back to left.
   */
  it('posts the back and forward side buttons as real button events', () => {
    expect(HELPER_SCRIPT).toContain('const uint MOUSEEVENTF_XDOWN = 0x0080, MOUSEEVENTF_XUP = 0x0100;');
    expect(HELPER_SCRIPT).toContain('const uint XBUTTON1 = 0x0001, XBUTTON2 = 0x0002;');
    expect(HELPER_SCRIPT).toContain('case "back": down = MOUSEEVENTF_XDOWN; up = MOUSEEVENTF_XUP; data = XBUTTON1; break;');
    expect(HELPER_SCRIPT).toContain('case "forward": down = MOUSEEVENTF_XDOWN; up = MOUSEEVENTF_XUP; data = XBUTTON2; break;');
    // The data word has to reach the event, or both side buttons would post as button 0.
    expect(HELPER_SCRIPT).toContain('ButtonFlags(button, out down, out up, out data);');
    expect(HELPER_SCRIPT).toMatch(/public static void Click[\s\S]*Mouse\(down, 0, 0, data\)[\s\S]*Mouse\(up, 0, 0, data\)/);
    expect(HELPER_SCRIPT).toMatch(/public static void Drag[\s\S]*Mouse\(down, 0, 0, data\)[\s\S]*Mouse\(up, 0, 0, data\)/);
  });

  /** And the same two buttons on macOS, by button number on an other-mouse event. */
  it('numbers the macOS side buttons instead of inventing shortcuts', () => {
    const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');
    expect(swift).toContain('case "back": return CGMouseButton(rawValue: 3) ?? .center');
    expect(swift).toContain('case "forward": return CGMouseButton(rawValue: 4) ?? .center');
    // Left and right stay on their own event types; everything else is an other-mouse event.
    expect(swift).toMatch(/private func mouseTypes[\s\S]*case \.left: return \(\.leftMouseDown/);
    expect(swift).toMatch(/private func mouseTypes[\s\S]*case \.right: return \(\.rightMouseDown/);
    expect(swift).toMatch(/private func mouseTypes[\s\S]*default: return \(\.otherMouseDown/);
  });

  /**
   * The vocabulary a computer-use model actually emits.
   *
   * Two names were refused before they ever reached code that knew what to do with them:
   * `wheel` for the middle button, which both native layers have always accepted while the
   * schema rejected it, and the DOM arrow names, which are what browser key vocabulary uses.
   *
   * Checked against the shipped `Vk` on this machine: ArrowLeft/Right/Up/Down resolve to
   * 0x25/0x27/0x26/0x28, Enter, Return, Escape, Backspace, Delete, Tab, Space, Home, End,
   * PageUp, PageDown, ctrl, alt, shift, cmd, meta, super, win, option, F5 and plain
   * letters/digits all resolve, and an unknown name is still refused.
   */
  it('accepts the button and key names computer use emits', () => {
    expect(HELPER_SCRIPT).toContain("'ARROWUP'=0x26; 'ARROWDOWN'=0x28; 'ARROWLEFT'=0x25; 'ARROWRIGHT'=0x27;");
    expect(HELPER_SCRIPT).toContain("'WIN'=0x5B; 'SUPER'=0x5B; 'CMD'=0x5B; 'META'=0x5B;");
    expect(HELPER_SCRIPT).toContain("'CTRL'=0x11; 'CONTROL'=0x11; 'ALT'=0x12; 'OPTION'=0x12; 'SHIFT'=0x10;");
    // An unrecognised name must still fail rather than resolving to something arbitrary.
    expect(HELPER_SCRIPT).toContain('throw "BAD_KEY: Unknown key: $name.');

    const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');
    expect(swift).toContain('case "arrowleft": return "left"');
    expect(swift).toContain('case "arrowright": return "right"');
    expect(swift).toContain('case "arrowup": return "up"');
    expect(swift).toContain('case "arrowdown": return "down"');
    expect(swift).toContain('case "cmd", "meta", "super", "win": return "command"');
    // Both helpers name what is accepted, not only what was refused: a 2026-09-04 QA run met
    // the macOS side's terser "unknown key <name>" and had nothing to correct itself from,
    // while the Windows side had listed valid names since that morning. Asserted per platform
    // because the two key vocabularies genuinely differ - macOS has no win/printscreen, and
    // Windows has no forwarddelete/volume keys - so a shared literal would be wrong on both.
    expect(swift).toContain('Use one character, or a key name: return, enter, tab, space,');
    expect(swift).toContain('command, option, control, shift');

    const kernel = readFileSync(path.join(process.cwd(), 'src/main/mcp/kernel.ts'), 'utf8');
    expect(kernel).toContain("z.enum(['left', 'right', 'middle', 'wheel', 'back', 'forward'])");
    // Both native layers already routed wheel to the middle button; only the schema refused.
    expect(HELPER_SCRIPT).toContain('case "middle": case "wheel":');
    expect(swift).toContain('case "middle", "wheel": return .center');
  });

  /**
   * One helper serves a whole swarm, so its snapshot cap is shared across every chat using it.
   *
   * Sixteen was measured as too few on 2026-09-01: thirteen workers taking turns evicted each
   * other's newest snapshot before its owner could act on a ref from it, forty STALE_UI_SNAPSHOT
   * refusals in one run. Windows was raised to 96 that day; macOS kept the sixteen that had just
   * been measured as broken, and a 2026-09-04 QA round on macOS was what surfaced the gap. The
   * number is asserted on both sides because the failure it prevents is a property of the shared
   * helper, not of either platform's UI layer.
   */
  it('retains the same number of UI snapshots on both platforms', () => {
    const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');
    expect(HELPER_SCRIPT).toContain('$script:MaxUiSnapshots = 96');
    expect(swift).toContain('private let maxUISnapshots = 96');
    // Read through the named constant on both sides, so raising one cannot leave a literal behind.
    expect(HELPER_SCRIPT).toContain('$script:UiSnapshots.Count -gt $script:MaxUiSnapshots');
    expect(swift).toContain('while snapshotOrder.count > maxUISnapshots');
  });

  /** And the same guarantee on the macOS side, where the capture API does it for us. */
  it('keeps the pointer in every macOS capture path', () => {
    const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');
    expect(swift.match(/configuration\.showsCursor = true/g)).toHaveLength(2);
    expect(swift).toMatch(/private func captureWindow[\s\S]*configuration\.showsCursor = true/);
    expect(swift).toMatch(/private func captureDisplay[\s\S]*configuration\.showsCursor = true/);
  });
});

/**
 * The same drag requirement, on the other platform.
 *
 * QA found the macOS drag reporting success while the file never moved, and the Windows helper
 * had the identical shape: press, jump to the destination, release. Explorer's shell drag makes
 * the same demands AppKit does — the press has to settle, the pointer has to travel continuously
 * far enough to cross the system threshold, and the destination needs a moment before the drop.
 * Fixing one platform and leaving the other is how a defect comes back wearing a different hat.
 */
describe('the Windows drag is paced like a real one', () => {
  it('holds the press, interpolates the path, and dwells before releasing', () => {
    expect(HELPER_SCRIPT).toContain('const int DragPressHoldMs');
    expect(HELPER_SCRIPT).toContain('const int DragDropDwellMs');
    expect(HELPER_SCRIPT).toContain('const double DragMaxStep');
    expect(HELPER_SCRIPT).toMatch(
      /Mouse\(down[\s\S]*Sleep\(DragPressHoldMs\)[\s\S]*Sleep\(DragStepMs\)[\s\S]*Sleep\(DragDropDwellMs\)[\s\S]*Mouse\(up/
    );
    // Bounded for the whole path, not per hop, so the cost of a drag does not grow with the
    // number of waypoints it happens to name — and cannot outlast the deadline that would kill
    // the helper before it releases the button.
    expect(HELPER_SCRIPT).toContain('const int DragMaxTotalSteps = 180;');
    expect(HELPER_SCRIPT).toContain('steps = (int)System.Math.Round(DragMaxTotalSteps * distance / total);');
    expect(HELPER_SCRIPT).not.toContain('if (steps > 240) steps = 240;');
  });
});

/**
 * A coordinate that claims to be in an image has to be in that image.
 *
 * The conversion from desktop to image space is plain arithmetic and answers for any point on
 * the desktop, including points the captured frame does not contain. So a pointer sitting below
 * a captured window produced "Pointer image: 875,754" for an image 646 pixels tall — a position
 * that cannot exist, which a caller would nonetheless use to address a pixel. QA found it.
 *
 * Outside the frame there is no image coordinate to give, and saying so is the whole fix: the
 * desktop position is still reported, and it is the one that was never in doubt.
 */
/**
 * A batch prints one set of refs, and it is the live one.
 *
 * The driver keeps only the newest observation addressable, replacing its ref map wholesale on
 * every observe. A call may carry several — observe, click, observe is an ordinary shape — and
 * printing all of them handed back a list whose earlier half no longer resolved, with nothing
 * marking where the dead half ended. A model picking from it would be refused and told only that
 * the ref was not from the most recent observation, which is true and unactionable.
 */
describe('a browser batch offers only refs that still resolve', () => {
  const tool = readFileSync(path.join(process.cwd(), 'src/main/mcp/tools-desktop.ts'), 'utf8');

  it('drops every observation but the last from what it prints', () => {
    expect(tool).toContain('const newestObservation = blocks.reduce(');
    expect(tool).toMatch(/index !== newestObservation[\s\S]{0,120}superseded by a later observation/);
    // The rendering itself is exercised in test/browser-answer.test.ts, which calls it. Here
    // only the call site's rule is pinned: a later observation overwrites an earlier picture.
    expect(tool).toContain('if (rendered.screenshot) shot = rendered.screenshot;');
  });
});

describe('the pointer never reports a position outside the image', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/main/computer/index.ts'), 'utf8');
  const tool = readFileSync(path.join(process.cwd(), 'src/main/mcp/tools-desktop.ts'), 'utf8');

  it('bounds the image coordinate by the frame it names', () => {
    expect(source).toContain('const inFrame = current');
    // Every edge of the frame, and the frame having to exist at all.
    expect(source).toMatch(
      /inFrame && current && inFrame\.x >= 0 && inFrame\.y >= 0 && inFrame\.x < current\.width && inFrame\.y < current\.height/
    );
  });

  it('says the pointer is outside rather than printing an impossible point', () => {
    expect(tool).toContain('it has no position in that image');
    // And still distinguishes that from having no frame at all, which is a different answer.
    expect(tool).toContain('No screenshot frame is active.');
  });
});

/**
 * A failed startup step must not take the control plane with it.
 *
 * Startup is one long promise chain, and it had nothing to catch a throw: anything that rejected
 * before the end silently stopped the rest — no bridge, no connect, no message. QA restarted the
 * app with Accessibility switched off, found the UI did not return, and both tunnels answered
 * tunnel_client_not_connected. A control plane that never started, indistinguishable from one
 * that started and broke.
 *
 * A permission the user revoked in System Settings must not be able to take the app's own
 * connection down with it.
 */
/**
 * The window title keeps the build identity.
 *
 * Electron hands the renderer's document title to the window as soon as the page loads, which
 * replaces whatever the BrowserWindow options set. So the version and commit were gone before
 * anyone could read them: a run on macOS found the window titled plainly "Chat On Steroids", and
 * could not determine which build it was measuring at all.
 *
 * That is the single thing this title exists for. Two builds with the same name and version is how
 * a QA run once came to measure the wrong app, and the guard against it had been inert since it
 * was written — silently, because a title that is merely wrong looks like a title.
 *
 * preventDefault is the load-bearing part. Setting the title again after load would hold only
 * until the next document-title change; refusing the event keeps it for good.
 */
describe('the window says which build it is', () => {
  const main = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const html = readFileSync(path.join(process.cwd(), 'src/renderer/index.html'), 'utf8');

  it('refuses the document title rather than letting it overwrite the build id', () => {
    expect(main).toContain('title: `Chat On Steroids ${BUILD_VERSION}`');
    expect(main).toMatch(/window\.on\('page-title-updated', \(event\) => \{\s*event\.preventDefault\(\);/);
    // And the reason it is needed: the document carries a title of its own, which is what used to
    // win. Leaving it there is fine — the refusal above is what decides.
    expect(html).toMatch(/<title>/);
  });
});

describe('startup survives a step that throws', () => {
  const main = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  it('logs the failure and still brings up the bridge and connection', () => {
    expect(main).toContain('let startedControlPlane = false;');
    expect(main).toContain('startedControlPlane = true;');
    expect(main).toMatch(/\.catch\(\(error: unknown\) => \{[\s\S]{0,400}logError\(`startup did not finish/);
    // The recovery is skipped when the control plane is already up, and when the window was
    // deliberately disabled — a second instance must not start a bridge behind the primary.
    expect(main).toMatch(/if \(startedControlPlane \|\| windowActivation\.isDisabled\(\)\) return;/);
    expect(main).toMatch(/\.catch\(\(error: unknown\)[\s\S]*void startBridge\(\)[\s\S]*autoConnect\(\)/);
    // And connect's own failure is no longer discarded: `void connect()` threw its rejection
    // away, which is how a restart with a revoked permission left both connectors answering
    // tunnel_client_not_connected with nothing anywhere saying why.
    expect(main).toContain('function autoConnect(): void {');
    expect(main).toMatch(/void connect\(\)\.catch\(\(error: unknown\) => \{[\s\S]{0,200}automatic connect failed/);
    expect(main).not.toMatch(/if \(getConfig\(\)\.ui\.autoConnect\) void connect\(\);/);
  });
});

/**
 * A tool that is missing has to say why it is missing.
 *
 * The condition for `browser` lives in the tool's own description, which can only be read once
 * the tool exists. When it is absent — the case a user is actually investigating — nothing said
 * anything, and a QA run lost its whole priority section to that silence before working the
 * reason out from source afterwards.
 *
 * Three reasons, and they are genuinely different actions: turn Read only off, turn the desktop
 * capability on, or install a build that has the feature at all.
 */
describe('the health check explains a missing browser tool', () => {
  const diagnostics = readFileSync(path.join(process.cwd(), 'src/main/diagnostics.ts'), 'utf8');

  it('names each reason separately, in the line the tool is missing from', () => {
    // Scoped to the surface the tool lives on. Reporting `browser` as absent from Core is true,
    // useless and alarming — and it happened, on a build that was serving it correctly.
    expect(diagnostics).toContain("if (surface === 'desktop' && !names.includes('browser'))");
    // Both surfaces get asked, or Core's list is mistaken for the whole server.
    expect(diagnostics).toContain("checkLocalServer(status.localUrl, 'core')");
    expect(diagnostics).toContain("checkLocalServer(desktop.localUrl, 'desktop')");
    expect(diagnostics).toContain('Read only is on, which withdraws desktop control');
    expect(diagnostics).toContain('"See and use the desktop" is off');
    expect(diagnostics).toContain('this build predates browser control');
    // Read-only is checked first: it withdraws control, so the capability check underneath it
    // would otherwise report the symptom rather than the cause.
    expect(diagnostics).toMatch(/if \(getConfig\(\)\.readOnly\)[\s\S]{0,200}else if \(!caps\.control\)/);
    expect(diagnostics).toContain('missingNote +');
  });

  /** And the build line, which decides what every other line in the report means. */
  it('leads with the build it is reporting on', () => {
    expect(diagnostics).toMatch(/name: 'Build'[\s\S]{0,300}BUILD_REVISION/);
  });
});

/**
 * One identity, in every place a build is named.
 *
 * A release number cannot tell two builds apart, and that ambiguity cost a whole QA run: an app
 * predating the feature under test was indistinguishable from one that had it, from the outside
 * and from ChatGPT's side alike. The commit rides along as semver build metadata — valid semver,
 * ignored by anything that compares versions, readable by anything that displays one.
 *
 * The bare release number survives only where the value is *compared* against a published tag:
 * the extension download URL and the bridge's compatibility reply. Everywhere it is *read*, it
 * carries the build.
 */
describe('a build can be told apart from every other build', () => {
  const version = readFileSync(path.join(process.cwd(), 'src/main/version.ts'), 'utf8');
  const tools = readFileSync(path.join(process.cwd(), 'src/main/mcp/tools.ts'), 'utf8');
  const index = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const diagnostics = readFileSync(path.join(process.cwd(), 'src/main/diagnostics.ts'), 'utf8');

  it('composes the shown version from the release and the commit', () => {
    expect(version).toContain('export const BUILD_VERSION =');
    expect(version).toContain("`${APP_VERSION}+${BUILD_REVISION}`");
    // A build with no revision says so rather than impersonating the release.
    expect(version).toContain("`${APP_VERSION}-dev`");
  });

  it('shows it wherever a build is named, including to ChatGPT', () => {
    // The connector's own version, which is the only identity that crosses to the other side.
    expect(tools).toContain('{ name: definition.serverName, version: BUILD_VERSION }');
    expect(index).toContain('title: `Chat On Steroids ${BUILD_VERSION}`');
    expect(index).toMatch(/logInfo\(`Chat On Steroids \$\{BUILD_VERSION\} starting/);
    expect(diagnostics).toContain('Chat On Steroids ${BUILD_VERSION}');
  });

  it('keeps the bare release where the value is compared, not read', () => {
    const bridge = readFileSync(path.join(process.cwd(), 'src/main/bridge.ts'), 'utf8');
    // The extension compatibility reply and the download URL both name a published release.
    expect(bridge).toContain('version: APP_VERSION');
    expect(version).toContain('export function extensionDownloadUrl(version = APP_VERSION)');
  });
});

/**
 * A failure has to say whether the thing may already have happened.
 *
 * QA clicked through the browser tool, the page visibly changed, and the reply was
 * BROWSER_TIMEOUT — "the browser took the action but did not report a result". True, and
 * useless: a caller reading that has no way to know a blind retry would click twice. Whether the
 * command was ever collected is the whole distinction, and the app already tracks it.
 */
describe('a browser failure says whether a retry is safe', () => {
  const control = readFileSync(path.join(process.cwd(), 'src/main/browser-control.ts'), 'utf8');

  it('separates never-collected from collected-and-silent, in both failure paths', () => {
    // Never collected: it cannot have run.
    expect(control).toContain('so it did not run; is the ChatGPT tab still open and paired? Safe to retry.');
    expect(control).toContain('so it did not run. Safe to retry once a page is back.');
    // Collected: it may have, so the instruction is not to repeat it blindly.
    expect(control).toContain('Do NOT retry it — observe first and decide from what the page now shows.');
    expect(control).toContain('so it may well have happened. Do NOT retry it — observe first.');
    // Both branches turn on the same recorded fact rather than on a guess.
    expect(control.match(/command\.collectedAt === null/g)).toHaveLength(2);
  });
});

/**
 * A drag that goes nowhere is refused, not performed.
 *
 * Mapped coordinates are clamped into the frame's region — right for a click at an edge, wrong
 * for a path. A route lying outside the frame collapses to one point: no threshold is crossed,
 * no drag session begins, and the helper answers ok because every event it was asked to post
 * was posted. QA reported "success with no effect" twice, and a separate measurement on the same
 * machine moved a file 6 times out of 6 driving the helper directly — the difference between
 * those two is this mapping, which the direct route never passes through.
 */
describe('a drag whose path collapses is refused', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/main/computer/index.ts'), 'utf8');

  it('checks the mapped path for distance, and says what to do about it', () => {
    expect(source).toContain('DRAG_PATH_COLLAPSED');
    // Judged after clamping, which is the only place the collapse can be seen.
    expect(source).toContain('const distinct = xs.some((x, index) => x !== xs[0] || ys[index] !== ys[0]);');
    // Nothing is sent, and the message names the cause that can actually occur here. Points are
    // checked against the frame before this, so an out-of-frame route never reaches it; what
    // does is a path too short to survive the scale of a Retina capture.
    expect(source).toContain('Nothing was sent — use endpoints further apart.');
    expect(source).toMatch(/DRAG_PATH_COLLAPSED[\s\S]{0,220}frame\.scale/);
  });
});
