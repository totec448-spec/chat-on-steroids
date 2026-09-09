import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');
const preparation = readFileSync(path.join(process.cwd(), 'scripts/prepare-macos-desktop-helper.mjs'), 'utf8');
const computer = readFileSync(path.join(process.cwd(), 'src/main/computer/index.ts'), 'utf8');
const desktopTools = readFileSync(path.join(process.cwd(), 'src/main/mcp/tools-desktop.ts'), 'utf8');

describe('macOS desktop safety hardening', () => {
  /**
   * A window in motion is told it is moving, not that it has no accessibility representation.
   *
   * Accessibility windows are matched to screen windows by geometry when the exact id is not
   * offered. The row is scanned at one instant and the AX bounds are read at another, so a window
   * being dragged between the two matches nothing — the rectangles describe it at different
   * moments. QA reached this by capturing a window while moving it and was told "no accessibility
   * window convincingly matches", which reads as a window that has no accessibility tree at all
   * and sends someone to check a permission that was never involved.
   *
   * The second read is the fix, not the message: a window that has come to rest matches on it and
   * the caller never learns there was a race at all.
   */
  it('looks again with the bounds a moved window has now', () => {
    expect(swift).toMatch(/if let fresh = windowRow\(row\.id\), fresh\.bounds != row\.bounds \{/);
    expect(swift).toContain('"WINDOW_MOVING"');
    expect(swift).toMatch(/WINDOW_MOVING[\s\S]{0,200}moved while its accessibility tree was being read/);
    // And the old answer survives for the case it was actually about: no match, no movement.
    expect(swift).toContain('no accessibility window convincingly matches window');
  });

  /**
   * A refusal to focus says which of the three facts disagreed.
   *
   * "the requested window could not be activated" is a sentence with no next step in it. QA hit
   * it against a Chrome window plainly on screen, and answering why would have meant an
   * instrumented build on the one machine that could reproduce it — for a fact the helper had
   * already computed and discarded.
   *
   * The diagnostic is deliberately a separate function. The fence stays exactly as it is,
   * because it is what physical input is judged by and every clause of it is asserted above;
   * a message must never be the thing deciding whether input is sent.
   */
  it('names the clause that refused a focus request', () => {
    expect(swift).toContain('private func inputTargetRefusal');
    // The reason is read first and then quoted into the message, so it precedes it.
    expect(swift).toMatch(/inputTargetRefusal\)[\s\S]{0,200}FOCUS_FAILED/);
    // The fence still decides; the diagnostic only explains.
    expect(swift).toMatch(/guard try focusWindow\(requested\) else \{/);
    expect(swift).not.toMatch(/if inputTargetRefusal\([\s\S]{0,60}== nil/);
  });

  it('requires exact Workspace, WindowServer and AX agreement for physical input', () => {
    expect(swift).toContain('private func windowServerFrontWindowID');
    expect(swift).toContain('private func focusedAXWindowID');
    expect(swift).toContain('private func focusedAXElementWindowID');
    expect(swift).toContain('private func assertInputTarget');
    expect(swift).toContain('private func assertFrameTarget');
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*frontmostPID\(\) == row\.pid/);
    expect(swift).toMatch(
      /private func inputTargetMatches[\s\S]*frontWindowID\(rows: rows, focusedWindow: focused\) == row\.id/
    );
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*guard focused == row\.id else \{ return false \}/);
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*guard focusedAXElementWindowID\(for: row\.pid, rows: rows\) == row\.id/);
    // frontWindowID is still WindowServer z-order; it only resolves which of one app's own
    // windows is front. All four clauses above still have to agree.
    expect(swift).toMatch(/private func frontWindowID[\s\S]*windowServerFrontWindowID\(rows: rows\)/);
  });

  /**
   * QA hit `No foreground window` while Chrome was plainly the active application, twice in a
   * row, with Chrome's link-preview bubble (`175x22` at the screen edge) and its omnibox popup
   * on top. Both are ordinary layer-0 windows of the browser, so WindowServer's topmost window
   * was the bubble while AX focus — and the user's typing — was the real window. The mismatch
   * was read as "an app transition is in flight" and everything was refused, which also made
   * `focusWindow` poll `inputTargetMatches` for a condition it could never satisfy.
   *
   * Only that intra-application case is resolved, and only in the frontmost application:
   * a covering window owned by *another* process must still refuse.
   */
  it('resolves one app\'s transient child windows without relaxing cross-app refusal', () => {
    expect(swift).toContain(
      'private func frontWindowID(rows: [WindowRow], focusedWindow: CGWindowID? = nil) -> CGWindowID?'
    );
    // Another app on top: returned as-is, so the caller's frontmostPID check still refuses.
    expect(swift).toContain(
      'guard let topRow = rows.first(where: { $0.id == top }), frontmostPID() == topRow.pid else { return top }'
    );
    // AX only wins when it names a different window this same scan already saw and admitted.
    // A caller that has already read the focused window hands it in, so the two of them cannot
    // reach different conclusions from two reads taken moments apart — see the race below.
    expect(swift).toContain(
      'guard let focused = focusedWindow ?? focusedAXWindowID(for: topRow.pid, rows: rows),'
    );
    expect(swift).toContain(
      'guard rows.contains(where: { $0.id == focused && $0.pid == topRow.pid }) else { return top }'
    );
    // Both readers go through it, so observation and input can never disagree about which
    // window is front.
    expect(swift).toMatch(/private func foregroundWindowID[\s\S]*guard let frontID = frontWindowID\(rows: rows, focusedWindow: focused\)/);
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*guard frontWindowID\(rows: rows, focusedWindow: focused\) == row\.id/);
    expect(swift).not.toMatch(/private func inputTargetMatches[\s\S]{0,200}windowServerFrontWindowID/);
  });

  /**
   * QA hit `No foreground window` while Chrome was plainly the active application, twice in a
   * row, with Chrome's link-preview bubble (`175x22` at the screen edge) and its omnibox popup
   * on top. Both are ordinary layer-0 windows of the browser, so WindowServer's topmost window
   * was the bubble while AX focus — and the user's typing — was the real window. The mismatch
   * was read as "an app transition is in flight" and everything was refused, which also made
   * `focusWindow` poll `inputTargetMatches` for a condition it could never satisfy.
   *
   * Only that intra-application case is resolved, and only in the frontmost application:
   * a covering window owned by *another* process must still refuse.
   */
  it('resolves one app\'s transient child windows without relaxing cross-app refusal', () => {
    expect(swift).toContain(
      'private func frontWindowID(rows: [WindowRow], focusedWindow: CGWindowID? = nil) -> CGWindowID?'
    );
    // Another app on top: returned as-is, so the caller's frontmostPID check still refuses.
    expect(swift).toContain(
      'guard let topRow = rows.first(where: { $0.id == top }), frontmostPID() == topRow.pid else { return top }'
    );
    // AX only wins when it names a different window this same scan already saw and admitted.
    // AX only wins when it names a different window this same scan already saw and admitted.
    // A caller that has already read the focused window hands it in, so the two of them cannot
    // reach different conclusions from two reads taken moments apart — see the race below.
    expect(swift).toContain(
      'guard let focused = focusedWindow ?? focusedAXWindowID(for: topRow.pid, rows: rows),'
    );
    expect(swift).toContain(
      'guard rows.contains(where: { $0.id == focused && $0.pid == topRow.pid }) else { return top }'
    );
    // Both readers go through it, so observation and input can never disagree about which
    // window is front.
    expect(swift).toMatch(/private func foregroundWindowID[\s\S]*guard let frontID = frontWindowID\(rows: rows, focusedWindow: focused\)/);
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*guard frontWindowID\(rows: rows, focusedWindow: focused\) == row\.id/);
    expect(swift).not.toMatch(/private func inputTargetMatches[\s\S]{0,200}windowServerFrontWindowID/);
  });

  it('revalidates a window-bound frame at every physical mutation boundary', () => {
    expect(swift).toMatch(/case "move":[\s\S]*assertFrameTarget\(frame\)[\s\S]*movePointer/);
    expect(swift).toMatch(/case "click", "double_click":[\s\S]*assertFrameTarget\(frame\)[\s\S]*guard let target = leasedWindow[\s\S]*targetWindow: target/);
    expect(swift).toMatch(/case "scroll":[\s\S]*assertFrameTarget\(frame\)[\s\S]*event\.post/);
    expect(swift).toMatch(/case "drag":[\s\S]*assertFrameTarget\(frame\)[\s\S]*guard let target = leasedWindow[\s\S]*targetWindow: target/);
    expect(swift).toMatch(/private func click[\s\S]*assertInputTarget\(targetWindow\)/);
    expect(swift).toMatch(/private func drag[\s\S]*assertInputTarget\(targetWindow\)/);
  });

  it('bounds AX-derived strings and keeps surrogate pairs in one text event', () => {
    expect(swift).toContain('private let maxAXStringCharacters = 4_096');
    expect(swift).toContain('return boundedAXString(value)');
    expect(swift).toContain('boundedAXString(axString(element, kAXIdentifierAttribute');
    expect(swift).toContain('units[end - 1] >= 0xD800');
    expect(swift).toContain('units[end] >= 0xDC00');
    expect(swift).toContain('end -= 1');
  });

  it('carries explicit modifier flags on synthesized shortcut events', () => {
    expect(swift).toContain('private let modifierFlags: [String: CGEventFlags]');
    expect(swift).toContain('event.flags = flags');
    expect(swift).toContain('CGEventSource(stateID: .privateState)');
    expect(swift).toContain('TISCopyCurrentKeyboardLayoutInputSource');
    expect(swift).toContain('UCKeyTranslate');
    expect(swift).toContain('active keyboard layout does not expose logical key');
    expect(preparation).toMatch(/'-framework',\s*'Carbon'/);
  });

  it('routes system shortcuts globally and rejects disabled semantic controls', () => {
    expect(swift).toContain('private func isSystemShortcut');
    expect(swift).toContain('if globalShortcut { event.post(tap: .cghidEventTap) }');
    expect(swift).toContain('UI_ACTION_DISABLED');
    expect(swift).toContain('the referenced accessibility control is disabled');
    // An explicit AXEnabled=false refuses every action. Silence defers to whether the value
    // can be written, which is the same evidence for a click as for a write — see the dedicated
    // test below for why the click half had to change.
    expect(swift).toContain('let enabled = axOptionalBool(element, kAXEnabledAttribute as CFString)');
    expect(swift).toContain('let permitted = enabled ?? axValueIsSettable(element)');
    expect(swift).toContain('["volumeup", "volumedown", "mute"]');
    expect(swift).toContain('(1...20).contains(value)');
  });

  it('rejects physical points that fall between active displays', () => {
    expect(swift).toContain('private func activeDisplayRects');
    expect(swift).toContain('private func requirePointOnActiveDisplay');
    expect(swift).toContain('OUTSIDE_ACTIVE_DISPLAY');
    expect(swift).toContain('for point in points { try requirePointOnActiveDisplay(point, displays: displays) }');
  });

  it('keeps old ScreenCaptureKit allocations bounded and window geometry honest', () => {
    expect(swift).toMatch(/if #available\(macOS 13\.0, \*\) \{\s*configuration\.width = width\s*configuration\.height = height/);
    expect(swift).toContain('CAPTURE_GEOMETRY_UNSAFE');
    expect(swift).toContain('configuration.ignoreShadowsSingleWindow = true');
    expect(swift).toContain('native display capture exceeds the decoded-pixel budget on macOS 12');
    expect(swift).toContain('private let maxEncodedScreenshotBytes = 6_242_304');
    expect(computer).toContain('export const MAX_SCREENSHOT_PNG_BYTES');
    expect(computer).toContain('SCREENSHOT_TOO_LARGE: encoded PNG');
  });

  it('bounds native AX messaging, traversal breadth and aggregate traversal time', () => {
    expect(swift).toContain('AXUIElementSetMessagingTimeout(system, 1.0)');
    expect(swift).toContain('private let maxAXTraversalSeconds = 6.0');
    expect(swift).toContain('accessibility traversal exceeded its bounded native deadline');
    expect(swift).toContain('AXUIElementCopyAttributeValues');
    expect(swift).toContain('axChildren(element, limit: remainingBudget)');
    expect(swift).toContain('axElementValues(app, attribute: kAXWindowsAttribute as CFString, limit: 64)');
    expect(swift).not.toContain('windows.prefix(64)');
    expect(swift).toContain('matchingAXWindow(row, deadline: deadline)');
  });

  it('validates AX value types and the live owning window of every semantic ref', () => {
    expect(swift).toMatch(/private func axPoint[\s\S]*CFGetTypeID\(value\) == AXValueGetTypeID\(\)/);
    expect(swift).toMatch(/private func axSize[\s\S]*CFGetTypeID\(value\) == AXValueGetTypeID\(\)/);
    expect(swift).toContain('private func unambiguousWindowID');
    expect(swift).toContain('private func owningAXWindowID');
    expect(swift).toContain('axPID(element) == currentWindow.pid');
    expect(swift).toMatch(/private func actUI[\s\S]*owningAXWindowID\(element, pid: currentWindow\.pid\) == snapshot\.window/);
  });

  it('binds screen frames to the exact active-display topology', () => {
    expect(swift).toContain('private func sameDisplayTopology');
    expect(swift).toContain('"displays": displayTopologyObject(finalDisplayRects)');
    expect(swift).toContain('let contentDisplayRects = content.displays.map(\\.frame)');
    expect(swift).toContain('sameDisplayTopology(displayRects, contentDisplayRects)');
    expect(swift).toContain('active display topology changed while screenshot capture was in progress');
    expect(swift).toContain('active display topology changed while screenshot was captured');
    expect(swift).toContain('active display topology changed after the screenshot');
    expect(computer).toContain('displayTopology: Rect[] | null');
    expect(computer).toContain('displays: frame.displayTopology');
  });

  it('keeps explicit UI and captured-pixel target identities fail-closed', () => {
    expect(swift).toMatch(/rawRequested = request\["id"\][\s\S]*WINDOW_NOT_FOUND/);
    expect(swift).toContain('window \\(requested) is no longer available');
    expect(computer).toContain('Publish the crop as');
    expect(computer).toMatch(/screenshotFromReply\(reply, file, opts\.crop \? null : opts\.window \?\? null\)/);
    expect(computer).not.toContain('lastFrame?.windowId ?? null : cropFrame?.windowId');
    expect(computer).toContain("const frameWindow = captureMode === 'window' ? requestedWindow : null");
    expect(computer).toContain('windowId: frameWindow');
    expect(computer).toContain("frame.captureMode !== 'screen_fallback'");
  });

  it('keeps every valid upscaled image pixel inside its desktop frame', () => {
    expect(computer).toContain('const upper = Math.max(lower, Math.ceil(origin + extent) - 1)');
    expect(computer).toContain('clampMappedCoordinate(Math.round(frame.region.x + x / frame.scale)');
    expect(computer).toContain('clampMappedCoordinate(Math.round(frame.region.y + y / frame.scale)');
  });

  it('budgets the actual combined Desktop text and image response', () => {
    expect(desktopTools).toContain("Buffer.byteLength(JSON.stringify(result), 'utf8')");
    expect(desktopTools).toContain('MAX_MCP_RESPONSE_BYTES - MCP_RESPONSE_ENVELOPE_RESERVE_BYTES');
    expect(desktopTools).toContain('DESKTOP_RESULT_TOO_LARGE');
  });

  it('carries proven semantic and explicit focus targets into later keyboard input', () => {
    expect(swift).toContain('var leasedWindow = frameWindow ?? requestedTargetWindow');
    expect(swift).toMatch(/case "click_ui", "set_value_ui":[\s\S]*leasedWindow = actionWindow/);
    expect(swift).toMatch(
      /case "type":[\s\S]*guard let target = leasedWindow[\s\S]*assertInputTarget\(target\)[\s\S]*targetWindow: target/
    );
    expect(swift).toMatch(
      /case "keypress":[\s\S]*if let target = leasedWindow \{[\s\S]*assertInputTarget\(target\)[\s\S]*targetWindow: target/
    );
    expect(swift).toMatch(/case "focus":[\s\S]*leasedWindow = requested/);
  });

  it('publishes only the newest overlapping macOS permission refresh', () => {
    expect(computer).toContain('macOSDesktopAccessRefreshGeneration');
    expect(computer).toContain('generation === macOSDesktopAccessRefreshGeneration');
  });

  it('keeps permission prompting in Electron and native execution fail-closed', () => {
    expect(swift).toContain('Swift code inside the Electron process on a Node Worker');
    expect(swift).toContain('Electron owns prompting through systemPreferences');
    expect(swift).not.toContain('AXIsProcessTrustedWithOptions');
    expect(swift).not.toContain('older unsigned/ad-hoc build');
  });

  it('keeps the fork targetWindow lease while preserving exact partial route evidence', () => {
    expect(swift).toContain('var leasedWindow = frameWindow ?? requestedTargetWindow');
    expect(swift).toContain('INPUT_TARGET_REQUIRED');
    expect(computer).toContain('targetWindow: number | null');
    expect(computer).toContain('readonly completedRoutes: ActionRoute[] | null');
    expect(computer).toContain('function completedHelperRoutes');
    expect(computer).toContain('const routeEvidence = exactRoutes');
  });

  it('bounds AX window copies and shares one native find_ui deadline', () => {
    expect(swift).toContain('private func axElementValues');
    expect(swift).toContain('axElementValues(app, attribute: kAXWindowsAttribute as CFString, limit: 64)');
    expect(swift).not.toContain('windows.prefix(64)');
    expect(swift).toContain('matchingAXWindow(_ row: WindowRow, deadline suppliedDeadline: TimeInterval? = nil)');
    expect(swift).toContain('let root = try matchingAXWindow(row, deadline: deadline)');
  });

  it('keeps visible fallback pixels screen-bound and clamps edge coordinates', () => {
    expect(computer).toContain("const frameWindow = captureMode === 'window' ? requestedWindow : null");
    expect(computer).toContain("frame.captureMode !== 'screen_fallback'");
    expect(computer).toContain('const clampMappedCoordinate =');
    expect(computer).toContain('INPUT_TARGET_UNPROVEN: visible screen_fallback pixels cannot authorize window-bound coordinate input');
  });

  it('bounds WindowServer strings and revalidates screen topology throughout long drags', () => {
    expect(swift).toContain('let process = boundedAXString(string(item[kCGWindowOwnerName as String]');
    expect(swift).toContain('let displayTitle = boundedAXString(title.isEmpty ?');
    expect(swift).toContain('expectedDisplays: [CGRect]? = nil');
    expect(swift).toContain('active display topology changed during the drag');
    expect(swift).toContain('targetWindow: target,');
    expect(swift).toContain('expectedDisplays: frameWindow == nil ? displayTopology(frame?["displays"]) : nil');
    expect(swift).toMatch(/func assertDragTarget[\s\S]*assertInputTarget\(targetWindow\)[\s\S]*sameDisplayTopology\(expectedDisplays, currentDisplays\)/);
  });

  it('keeps valid screenshots when only AX semantic traversal is unavailable', () => {
    // This test used to pin the list of codes that were let through, and pinning a list is what
    // let the defect in: splitting `UIA_AMBIGUOUS_WINDOW` out of `UIA_FAILED` took the new code
    // off the list, so a snapshot of a window that could not be told apart from another returned
    // neither the tree nor the picture — while asking for the picture alone still worked. A test
    // that enumerates cannot fail on a case nobody thought to enumerate. So it pins the property
    // instead: the exception asks what the failure *is*.
    expect(swift).toContain('} catch let error as HelperFailure where onlyTheTreeFailed(error.code) {');
    // Only a target-identity failure invalidates the capture. Permission, a malformed tree, a
    // timeout, an id belonging to another window, an ambiguous window — all leave an image that
    // is still valid and still wanted, so none of them may appear in the refusing case.
    expect(swift).toContain('    case "WINDOW_NOT_FOUND", "WINDOW_MOVING", "BAD_REQUEST":');
    const decision = swift.slice(swift.indexOf('private func onlyTheTreeFailed'));
    for (const treeOnly of [
      'ACCESSIBILITY_PERMISSION_REQUIRED',
      'UIA_FAILED',
      'UIA_TIMEOUT',
      'UIA_NO_OWN_WINDOW',
      'UIA_AMBIGUOUS_WINDOW'
    ]) {
      expect(decision.slice(0, 400)).not.toContain(treeOnly);
    }
    // A window that is gone is named rather than described as an empty desktop: a caller that
    // asked for one window in particular should not have to guess which of the two happened.
    expect(swift).toContain('is no longer on screen');
    expect(swift).not.toContain('no matching visible window is available');
  });

  /**
   * The scroll-settle ceiling is read from the clock, not counted in requested microseconds.
   *
   * `settledScrollState`'s loop used to add the *requested* 10_000 µs to `elapsed` on every turn,
   * never the time `usleep` had actually spent. A QA round measured `usleep(10_000)` costing a
   * median 12.06 ms on real hardware — before a single AX read even ran — so the loop's own
   * 120 ms ceiling was reached at 145–348 ms by the wall clock. `systemUptime` is the deadline
   * idiom every other wait in this file already uses; this one now matches them.
   */
  it('settles a scroll against the clock, not a count of requested microseconds', () => {
    expect(swift).toMatch(
      /let deadline = ProcessInfo\.processInfo\.systemUptime \+ 0\.120\s*\n\s*while ProcessInfo\.processInfo\.systemUptime < deadline \{/
    );
    // The old accounting is gone outright, not left dead beside the fix.
    expect(swift).not.toMatch(/elapsed:\s*useconds_t/);
    expect(swift).not.toContain('elapsed += 10_000');
  });

  /**
   * An unrecognized field is refused everywhere it is cheap to check, not just on `act`.
   *
   * `window` was fixed as its own case first, then `act` got a general stray-key check — and a
   * QA round measured that the rule had still not reached anywhere else: `warm`, `cursor` and
   * `windows` took any key at all and silently did nothing with it, answering `ok: true` for a
   * field that was never read. This pins that the same shape of check now guards those three.
   */
  it('rejects an unrecognized field on warm, cursor and windows instead of silently ignoring it', () => {
    expect(swift).toMatch(/operation == "warm" \|\| operation == "cursor"/);
    expect(swift).toMatch(/request\.keys\.first\(where: \{ \$0 != "op" \}\)/);
    expect(swift).toContain('It takes no fields beyond `op`. Nothing was done.');

    expect(swift).toMatch(/if operation == "windows" \{[\s\S]{0,300}knownWindowsKeys/);
    expect(swift).toContain('let knownWindowsKeys: Set<String> = ["op", "focusable"]');
    expect(swift).toContain('windows does not recognize `\\(strayKey)`. It reads `focusable` only, besides `op`. Nothing was done.');

    // Both new checks run before the switch that actually does the work, the same place the
    // existing `act` check runs — a request refused here must not fall through and act anyway.
    const beforeSwitch = swift.slice(swift.indexOf('private func handle('), swift.indexOf('var result: JSONObject = ["ok": true]'));
    expect(beforeSwitch).toContain('operation == "warm" || operation == "cursor"');
    expect(beforeSwitch).toContain('if operation == "windows" {');
  });

  it('retains the documented process-global AX timeout contract', () => {
    expect(swift).toContain('let system = AXUIElementCreateSystemWide()');
    expect(swift).toContain('AXUIElementSetMessagingTimeout(system, 1.0)');
  });

  /**
   * The 2.0.2 release blocker: `pressKeys` read the active input source from the Node worker
   * thread the addon is entered on. Text Services is main-queue-affine, so macOS did not
   * return an error — `dispatch_assert_queue` failed and EXC_BREAKPOINT took the whole host
   * process down, below anything Swift or JS could catch.
   *
   * This file cannot execute the addon, so it holds the shape of the fix: the Text Services
   * calls appear only inside the main-queue read, the wait is bounded rather than
   * `DispatchQueue.main.sync`, and the search that does not need main affinity stays off it.
   */
  it('reads the keyboard input source on the main queue, without sync or an unbounded wait', () => {
    expect(swift).toContain('private func currentKeyboardLayout() -> KeyboardLayoutSnapshot?');
    // Both Text Services calls live in that one function and nowhere else.
    expect(swift.match(/TISCopyCurrentKeyboardLayoutInputSource/g)).toHaveLength(1);
    expect(swift.match(/TISGetInputSourceProperty/g)).toHaveLength(1);
    expect(swift).toMatch(
      /private func currentKeyboardLayout\(\)[\s\S]*onMainQueue \{[\s\S]*TISCopyCurrentKeyboardLayoutInputSource[\s\S]*TISGetInputSourceProperty/
    );

    // The layout bytes are copied out: they belong to an input source released on return.
    expect(swift).toContain('Data(bytes: bytes, count: CFDataGetLength(data))');
    // UCKeyTranslate is pure over those bytes, so the 128-keycode search — the expensive
    // half — stays out of the main-queue section and off the UI thread entirely.
    expect(swift).toMatch(
      /private func currentLayoutKey\(for logicalName: String, in snapshot: KeyboardLayoutSnapshot\)[\s\S]*UCKeyTranslate/
    );
    const hop = swift.slice(
      swift.indexOf('private func onMainQueue'),
      swift.indexOf('private let keyCodes')
    );
    expect(hop).not.toContain('UCKeyTranslate');
  });

  /**
   * One marshal, used by everything that needs AppKit or Text Services from the addon's
   * worker thread. A bounded, deadlock-free hop is exactly the primitive that must not exist
   * in two slightly different copies.
   */
  it('marshals to the main queue once, inline when already there and never unbounded', () => {
    expect(swift.match(/private func onMainQueue<Value>/g)).toHaveLength(1);
    expect(swift).toContain('if Thread.isMainThread { return work() }');
    // The call, not the prose: the function's own comment names it as the thing to avoid.
    expect(swift).not.toMatch(/DispatchQueue\.main\.sync\s*[({]/);
    expect(swift).toContain('private let mainQueueTimeout: TimeInterval = 2.0');
    expect(swift).toContain('done.wait(timeout: .now() + mainQueueTimeout) == .success');
    expect(swift).toContain('"the active keyboard layout could not be read in time"');
    // Every AppKit/Text Services reader goes through it rather than dispatching its own.
    expect(swift.match(/DispatchQueue\.main\.async/g)).toHaveLength(1);
  });

  /**
   * The pointer has to be drawn into a window capture, because `showsCursor` cannot reach it.
   *
   * A desktop-independent window filter captures the window detached from the desktop, and the
   * pointer is a display compositing layer rather than part of any window's content — so the
   * flag is set and does nothing on exactly the path an ordinary `observe` on a window uses.
   * Display capture keeps the system's own pointer, which is why only windows are composited.
   */
  it('composites the pointer into a window capture, at its hotspot', () => {
    expect(swift).toContain('private func drawingPointer(on image: CGImage, region: CGRect) -> (CGImage, String)');
    expect(swift).toMatch(
      /private func captureWindow[\s\S]*SCContentFilter\(desktopIndependentWindow: window\)[\s\S]*drawingPointer\(on: resized, region: region\)/
    );
    // Read through the shared hop, because NSCursor is AppKit.
    expect(swift).toMatch(/private func currentPointerImage\(\)[\s\S]*onMainQueue \{[\s\S]*NSCursor\.currentSystem/);
    // At the hotspot — the pixel the pointer addresses — not the image origin.
    expect(swift).toContain('let x = (location.x - pointer.hotSpot.x - region.minX) * scale');
    expect(swift).toContain('let top = (location.y - pointer.hotSpot.y - region.minY) * scale');
    // A pointer that is not over this window is not drawn onto it.
    expect(swift).toContain('region.contains(location)');
    // Display capture still gets the system pointer, and must not be composited twice.
    expect(swift.match(/configuration\.showsCursor = true/g)).toHaveLength(2);
    expect(swift).not.toMatch(/private func captureDisplay[\s\S]{0,600}drawingPointer/);
  });

  /**
   * A pointer missing from a window screenshot looks the same whichever reason caused it, and
   * that ambiguity already cost one round of guessing at which. So each way of drawing nothing
   * names itself, and the reason reaches the response — the only place a person reading a QA
   * report can see it.
   */
  /**
   * A drag has to look like a drag to the system that decides what a drag means.
   *
   * QA dragged a file in Finder three times, was told "Done" three times, and the file never
   * moved. The events were posted; nothing read them as a drag. AppKit distinguishes a press
   * that begins a drag session from one that is merely a click by whether the press settles and
   * whether the pointer then travels continuously past a threshold — and the old code pressed,
   * jumped straight to the destination, and released. Two waypoints are a teleport.
   *
   * Reported success without effect is worse than a clean failure, because a caller builds its
   * next decision on a world state that never happened.
   */
  /**
   * The focused window is read once per decision, not twice.
   *
   * frontWindowID reads AX focus to resolve an application's transient child windows, and both
   * of its callers then read the same fact again to check the two agree. Between those reads
   * focus can move — a bubble opens, a popup closes — and a second answer disagreeing with the
   * first was treated as an app transition in flight. QA saw both halves of that: `No foreground
   * window` while Chrome plainly occupied the screen, and FOCUS_FAILED against a window that was
   * visibly active, because focusWindow polls the input fence and could never satisfy a
   * condition that was partly a race.
   *
   * Every clause still has to hold. They just judge one observation instead of two.
   */
  /**
   * The active application is read fresh, not from a cache nobody refills.
   *
   * NSWorkspace serves frontmostApplication from a running-applications cache that AppKit keeps
   * current by delivering notifications on a run loop. The standalone helper has none — it reads
   * commands with readLine() on the main thread and never returns to one — so the cache was
   * fixed at first access and every application launched afterwards stayed invisible to it, for
   * the life of the process. The app runs one long-lived helper, which made that permanent.
   *
   * QA reproduced it with two helpers on one desktop: the one that had queried before TextEdit
   * launched reported no foreground window and kept doing so, while a freshly started one was
   * correct throughout. Window enumeration was unaffected either way, because that goes through
   * CGWindowListCopyWindowInfo — hence a window listed, capturable and plainly in front that
   * nothing would call foreground.
   *
   * This is a second, independent cause of the same symptom as the transient child-window case.
   * Fixing that one did not touch this one.
   */
  /**
   * "Nothing is in front" and "I am in front" are different answers.
   *
   * The helper excludes its own process from window enumeration on purpose — the model must not
   * be able to drive the app that is driving it — and in a packaged build the helper runs inside
   * that app, so every Chat On Steroids window disappears. Correct, but it made foreground
   * resolution answer nothing whenever the app itself was frontmost, which reads as the defect
   * QA reported rather than as the refusal it is.
   */
  it('says when the frontmost application is the one it may not drive', () => {
    expect(swift).toContain('result["foregroundIsSelf"] = frontmostPID() == getpid()');
    // Both the cheap query and the one that carries a window report it.
    expect(swift).toMatch(/case "cursor":[\s\S]{0,900}foregroundIsSelf/);
    expect(swift).toMatch(/case "active":[\s\S]{0,200}foregroundIsSelf/);
    // The exclusion itself is unchanged; this only describes it.
    expect(swift).toContain('pid != ownPid');
  });

  it('reads the frontmost application fresh rather than from a frozen cache', () => {
    expect(swift).toMatch(
      /private func frontmostPID\(\) -> pid_t\? \{[\s\S]{0,400}CFRunLoopRunInMode\(\.defaultMode, 0, true\)/
    );
    // Bounded and non-blocking: a zero timeout returns at once when nothing is pending, and the
    // pass count is capped so a busy run loop cannot hold a command hostage.
    expect(swift).toContain('while drained < 32, CFRunLoopRunInMode(.defaultMode, 0, true) == .handledSource');
    // Behind the main-queue hop, like every other AppKit read in this file, and reached only
    // after the drain — an unguarded call elsewhere would reintroduce the stale answer.
    expect(swift).toMatch(/private func frontmostPID[\s\S]{0,900}onMainQueue \{/);
    expect(swift).toMatch(
      /CFRunLoopRunInMode[\s\S]{0,200}NSWorkspace\.shared\.frontmostApplication\?\.processIdentifier/
    );
  });

  it('judges one reading of the focused window, not two', () => {
    expect(swift).toMatch(
      /private func foregroundWindowID[\s\S]*let focused = AXIsProcessTrusted\(\) \? focusedAXWindowID\(for: pid, rows: rows\) : nil/
    );
    expect(swift).toMatch(
      /private func foregroundWindowID[\s\S]*frontWindowID\(rows: rows, focusedWindow: focused\)/
    );
    expect(swift).toMatch(/private func foregroundWindowID[\s\S]*if let focused, focused != front\.id \{ return nil \}/);
    // The input fence reads once as well, and still requires all of its clauses.
    expect(swift).toMatch(
      /private func inputTargetMatches[\s\S]*let focused = focusedAXWindowID\(for: row\.pid, rows: rows\)/
    );
    expect(swift).toMatch(
      /private func inputTargetMatches[\s\S]*frontWindowID\(rows: rows, focusedWindow: focused\) == row\.id/
    );
    expect(swift).toMatch(
      /private func inputTargetMatches[\s\S]*focusedAXElementWindowID\(for: row\.pid, rows: rows\) == row\.id/
    );
  });

  it('paces a drag so the system reads it as one, rather than as a click', () => {
    expect(swift).toContain('private let dragPressHoldMicroseconds');
    expect(swift).toContain('private let dragDropDwellMicroseconds');
    expect(swift).toContain('private func dragSteps(from start: CGPoint, to end: CGPoint, steps: Int)');
    // Hold after the press, travel, then dwell before releasing — in that order.
    expect(swift).toMatch(
      /postMouse\(down[\s\S]*usleep\(dragPressHoldMicroseconds\)[\s\S]*dragSteps\(from: current[\s\S]*usleep\(dragDropDwellMicroseconds\)[\s\S]*postMouse\(up/
    );
    // Every interpolated event still re-proves the target; pacing must not cost the fence.
    expect(swift).toMatch(/for step in dragSteps[\s\S]{0,200}try assertDragTarget\(\)/);
    // Bounded for the whole path, not per hop. Per hop, a 64-waypoint drag could spend two
    // minutes inside a 15-second parent deadline — and a helper killed there never reaches the
    // release, leaving the button logically held down.
    expect(swift).toContain('private let dragMaxTotalSteps = 180');
    expect(swift).toContain('private func dragStepBudget(_ points: [CGPoint]) -> [Int]');
    expect(swift).toMatch(/guard wantedTotal > dragMaxTotalSteps, total > 0 else \{ return wanted \}/);
    expect(swift).not.toMatch(/min\(count, 240\)/);
  });

  it('says why no pointer was drawn, instead of drawing nothing silently', () => {
    for (const reason of ['unavailable', 'outside_region', 'buffer_unavailable', 'drawn']) {
      expect(swift).toContain(`"${reason}"`);
    }
    // The system draws the pointer for a display filter, so those paths say so rather than
    // claiming this code drew it.
    expect(swift).toMatch(/pointerNote = "system"/);
    // And it is actually reported, not just computed.
    expect(swift).toContain('"pointer": pointerNote');
    expect(swift).toMatch(/captureWindow[\s\S]{0,200}throws -> \(CGImage, CGRect, String\)/);
  });

  /**
   * QA found a blank TextEdit document refused with UI_ACTION_DISABLED while physical typing
   * into the same control worked. TextEdit's document AXTextArea publishes no AXEnabled
   * attribute at all, and the gate read that silence as false.
   *
   * A value write has a stronger authority available — accessibility says directly whether
   * AXValue can be written — so silence defers to that. Silence still refuses a click, and an
   * explicit AXEnabled=false still refuses everything: a control that says it is disabled is
   * disabled whatever it reports about settability.
   */
  it('lets a settable value speak for a control that publishes no AXEnabled, for click as well as write', () => {
    expect(swift).toContain('private func axOptionalBool');
    expect(swift).toContain('private func axValueIsSettable');
    // The same evidence now answers for a click. QA found the other half of the defect: the
    // very TextArea this fix made writable was still refused for click_ref, while a coordinate
    // click focused it and typing worked. Silence alone still refuses — no AXEnabled and no
    // settable value gets nothing — but silence next to a settable value is not a refusal.
    expect(swift).toContain('let permitted = enabled ?? axValueIsSettable(element)');
    expect(swift).not.toContain('(enabled ?? false)');
    // Read once, before the branch, so the refusal cannot disagree with the write below it.
    expect(swift).toMatch(
      /let enabled = axOptionalBool\(element, kAXEnabledAttribute as CFString\)[\s\S]*guard permitted else \{[\s\S]*UI_ACTION_DISABLED/
    );
    expect(swift).toMatch(/if action == "set_value" \{\s*\n\s*guard axValueIsSettable\(element\),/);
    // The generic helper keeps its old meaning for every other caller.
    expect(swift).toContain('axOptionalBool(element, attribute) ?? fallback');
  });

  /**
   * And the ordering the crash fix must not cost us: the layout is taken before any window
   * authority is resolved, so the existing revalidations still sit immediately before the
   * events they guard. Fixing a P1 crash must not open a wrong-window race.
   */
  it('takes the layout snapshot once, ahead of every target-window revalidation', () => {
    expect(swift).toMatch(
      /let layout = normalized\.contains \{ \$0\.count == 1 \} \? currentKeyboardLayout\(\) : nil\s*\n\s*let resolved = try normalized\.map \{ try resolveKey\(\$0, in: layout\) \}/
    );
    expect(swift).toMatch(
      /let resolved = try normalized\.map \{ try resolveKey\(\$0, in: layout\) \}[\s\S]*if let targetWindow \{ targetPID = try assertInputTarget\(targetWindow\)\.pid \}/
    );
    expect(swift).toMatch(
      /A window transition while modifiers are down must abort before the ordinary key\.\s*\n\s*if let targetWindow \{ targetPID = try assertInputTarget\(targetWindow\)\.pid \}/
    );
  });
});
