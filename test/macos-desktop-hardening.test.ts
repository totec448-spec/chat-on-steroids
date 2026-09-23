import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');
const preparation = readFileSync(path.join(process.cwd(), 'scripts/prepare-macos-desktop-helper.mjs'), 'utf8');
const computer = readFileSync(path.join(process.cwd(), 'src/main/computer/index.ts'), 'utf8');
const desktopTools = readFileSync(path.join(process.cwd(), 'src/main/mcp/tools-desktop-macos.ts'), 'utf8');

describe('macOS desktop safety hardening', () => {
  it('requires exact Workspace, WindowServer and AX agreement for physical input', () => {
    expect(swift).toContain('private func windowServerFrontWindowID');
    expect(swift).toContain('private func focusedAXWindowID');
    expect(swift).toContain('private func focusedAXElementWindowID');
    expect(swift).toContain('private func assertPointerTarget');
    expect(swift).toContain('private func assertInputTarget');
    expect(swift).toContain('private func assertFrameTarget');
    expect(swift).toContain('let reportedOnScreen = number(item[kCGWindowIsOnscreen as String])?.boolValue');
    expect(swift).toContain('let missingOnScreenFallback = reportedOnScreen == nil && onScreenIDs.contains(id) && !title.isEmpty');
    expect(swift).toContain('let onScreen = reportedOnScreen ?? missingOnScreenFallback');
    expect(swift).toMatch(/private func focusTargetMatches[\s\S]*frontmostPID\(\) == row\.pid[\s\S]*focusedAXWindowID\(for: row\.pid, rows: rows\) == row\.id/);
    expect(swift).toMatch(/private func focusWindow[\s\S]*focusTargetMatches\(row\)/);
    expect(swift).toMatch(/private func pointerTargetMatches[\s\S]*frontmostPID\(\) == row\.pid/);
    expect(swift).toMatch(/private func pointerTargetMatches[\s\S]*windowServerFrontWindowID\(rows: rows\) == row\.id/);
    expect(swift).toMatch(/private func pointerTargetMatches[\s\S]*focusedAXWindowID\(for: row\.pid, rows: rows\) == row\.id/);
    expect(swift).toMatch(/private func pointerTargetMatches[\s\S]*windowServerTopWindowID\(at: point\) == row\.id/);
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*frontmostPID\(\) == row\.pid[\s\S]*focusedAXWindowID\(for: row\.pid, rows: rows\) == row\.id/);
    const keyboardProof = swift.slice(swift.indexOf('private func inputTargetMatches'), swift.indexOf('private func assertPointerTarget'));
    expect(keyboardProof).not.toContain('pointerTargetMatches(row)');
    expect(keyboardProof).not.toContain('windowServerFrontWindowID');
    expect(keyboardProof).not.toContain('focusedAXElementWindowID');
  });

  it('falls back to Workspace only when system-wide AX reports an invalid focused-app pid', () => {
    expect(swift).toMatch(/kAXFocusedApplicationAttribute[\s\S]*let pid = axPID\(focused\),[\s\S]*pid > 0[\s\S]*return pid/);
    expect(swift).toMatch(/private func frontmostPID[\s\S]*return NSWorkspace\.shared\.frontmostApplication\?\.processIdentifier/);
  });

  it('keeps AX-proven off-Space windows discoverable without weakening pointer proof', () => {
    expect(swift).toContain('private func offscreenAXWindowStates');
    expect(swift).toContain('let offscreenStates = offscreenAXWindowStates(in: rows)');
    expect(swift).toContain('guard let minimized = offscreenStates[row.id] else { return nil }');
    expect(swift).toContain('"state": id == foreground ? "foreground" : (minimized ? "minimized" : "open")');
    expect(swift).toMatch(/offscreenAXWindowStates[\s\S]*unambiguousWindowID\(bounds: bounds, pid: pid, rows: rows\)/);
    expect(swift).toMatch(/matchingAXWindow[\s\S]*kAXFocusedWindowAttribute[\s\S]*unambiguousWindowID/);
    expect(swift).toMatch(/private func pointerTargetMatches[\s\S]*windowServerFrontWindowID\(rows: rows\) == row\.id/);
  });

  it('rejects contradictory positive AX ids before geometry fallback', () => {
    expect(swift).toContain('id = rows.contains(where: { $0.id == exact && $0.pid == pid }) ? exact : nil');
    expect(swift).toMatch(/if let exact = axWindowNumber\(preferred\)[\s\S]*if exact == row\.id[\s\S]*continue/);
    expect(swift).toContain('guard axWindowNumber(window) == nil, let bounds = axBounds(window)');
  });

  it('includes floating windows in point occlusion proof', () => {
    const start = swift.indexOf('private func windowServerTopWindowID');
    const end = swift.indexOf('private func pointerTargetMatches');
    const proof = swift.slice(start, end);
    expect(proof).not.toContain('eligible.contains(id)');
    expect(proof).toContain('let dockBackdrop = layer == 20 && owner == "Dock" && name == "Dock"');
    expect(proof).toContain('if dockBackdrop { continue }');
    expect(proof).not.toContain('int(item[kCGWindowLayer as String]) == 0');
    expect(proof).toContain('bounds.contains(point)');
  });

  it('allows only AX-proven off-Space frames to activate before requiring on-screen pointer proof', () => {
    expect(swift).toMatch(/private func validateFrame[\s\S]*let discovered = windowRow\(windowID\)[\s\S]*guard let row = discovered \?\? chromeRecovery[\s\S]*focusWindow\(windowID\)[\s\S]*after\.onScreen[\s\S]*assertFrameTarget\(frame\)/);
    expect(swift).toMatch(/private func assertFrameTarget[\s\S]*guard let row = windowRow\(windowID\), row\.onScreen/);
    expect(swift).toMatch(/private func assertPointerTarget[\s\S]*guard let row = windowRow\(id\), row\.onScreen/);
  });

  it('keeps Chrome off-Space recovery narrow and revalidates the exact WindowServer id', () => {
    expect(swift).toMatch(/private func rawWindowRow[\s\S]*\.optionAll, \.excludeDesktopElements\], kCGNullWindowID/);
    expect(swift).toMatch(/private func rawWindowRow[\s\S]*raw\.first\(where: \{ number\(\$0\[kCGWindowNumber as String\]\)\?\.uint32Value == id \}\)/);
    expect(swift).toMatch(/private func focusWindow[\s\S]*let discovered = windowRow\(id\)[\s\S]*let raw = discovered == nil \? rawWindowRow\(id\) : nil/);
    expect(swift).toMatch(/let chromeRecovery = raw\.flatMap[\s\S]*!candidate\.onScreen[\s\S]*bundleIdentifier == "com\.google\.Chrome"/);
    expect(swift).toMatch(/guard let row = discovered \?\? chromeRecovery else \{ return false \}/);
    expect(swift).toMatch(/restoreChromeWindowFromAnotherSpace[\s\S]*bundleIdentifier == "com\.google\.Chrome"/);
    expect(swift).toContain('if (count of matches) is not 1 then error "ambiguous Chrome window title"');
    expect(swift).toMatch(/restoreChromeWindowFromAnotherSpace[\s\S]*windowRow\(row\.id\)[\s\S]*current\.onScreen/);
    expect(swift).toMatch(/private func focusWindow[\s\S]*!row\.onScreen && restoreChromeWindowFromAnotherSpace\(row\)/);
    expect(swift).toMatch(/restored\.pid == row\.pid, restored\.title == row\.title/);
    expect(swift).toMatch(/if !row\.onScreen && restoreChromeWindowFromAnotherSpace[\s\S]*consecutiveMatches >= 3/);
  });

  it('revalidates a window-bound frame at every physical mutation boundary', () => {
    expect(swift).toMatch(/case "move":[\s\S]*assertFrameTarget\(frame\)[\s\S]*movePointer/);
    expect(swift).toMatch(/case "click", "double_click":[\s\S]*assertFrameTarget\(frame\)[\s\S]*targetWindow: frameWindow/);
    expect(swift).toMatch(/case "scroll":[\s\S]*assertFrameTarget\(frame\)[\s\S]*event\.post/);
    expect(swift).toMatch(/case "drag":[\s\S]*assertFrameTarget\(frame\)[\s\S]*targetWindow: frameWindow/);
    expect(swift).toMatch(/private func click[\s\S]*assertPointerTarget\(targetWindow, point: point\)/);
    expect(swift).toMatch(/private func drag[\s\S]*assertPointerTarget\(targetWindow, point:/);
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
    const pressKeysProof = swift.slice(swift.indexOf('private func pressKeys'), swift.indexOf('private func typeText'));
    expect(pressKeysProof).toContain('focusTargetMatches(row)');
    expect(pressKeysProof).toContain('lost focused-window ownership while modifiers were down');
  });

  it('routes system shortcuts globally and rejects disabled semantic controls', () => {
    expect(swift).toContain('private func isSystemShortcut');
    expect(swift).toContain('if globalShortcut { event.post(tap: .cghidEventTap) }');
    expect(swift).toContain('UI_ACTION_DISABLED');
    expect(swift).toContain('the referenced accessibility control is disabled');
    expect(swift).toContain('axBool(element, kAXEnabledAttribute as CFString, default: false)');
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
    expect(swift).toContain('let contentDisplayRects = content.displays.map(\\.frame)');
    expect(swift).toContain('sameDisplayTopology(displayRects, contentDisplayRects)');
    expect(swift).toContain('active display topology changed while screenshot capture was in progress');
    expect(swift).toContain('active display topology changed while screenshot was captured');
    expect(swift).toContain('"displays": displayTopologyObject(displayRects)');
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
    expect(computer).toContain('windowId: frame.windowId');
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
    expect(swift).toContain('var inputWindow = frameWindow');
    expect(swift).toMatch(/case "click_ui", "set_value_ui":[\s\S]*inputWindow = actionWindow/);
    expect(swift).toMatch(/case "type":[\s\S]*assertInputTarget\(inputWindow\)[\s\S]*targetWindow: inputWindow/);
    expect(swift).toMatch(/case "keypress":[\s\S]*assertInputTarget\(inputWindow\)[\s\S]*targetWindow: inputWindow/);
    expect(swift).toMatch(/case "focus":[\s\S]*inputWindow = requested/);
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
});
