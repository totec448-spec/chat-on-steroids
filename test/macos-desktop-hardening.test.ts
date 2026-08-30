import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');
const preparation = readFileSync(path.join(process.cwd(), 'scripts/prepare-macos-desktop-helper.mjs'), 'utf8');
const computer = readFileSync(path.join(process.cwd(), 'src/main/computer/index.ts'), 'utf8');

describe('macOS desktop safety hardening', () => {
  it('requires exact Workspace, WindowServer and AX agreement for physical input', () => {
    expect(swift).toContain('private func windowServerFrontWindowID');
    expect(swift).toContain('private func focusedAXWindowID');
    expect(swift).toContain('private func focusedAXElementWindowID');
    expect(swift).toContain('private func assertInputTarget');
    expect(swift).toContain('private func assertFrameTarget');
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*frontmostPID\(\) == row\.pid/);
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*windowServerFrontWindowID\(rows: rows\) == row\.id/);
    expect(swift).toMatch(/private func inputTargetMatches[\s\S]*focusedAXWindowID\(for: row\.pid, rows: rows\) == row\.id/);
  });

  it('revalidates a window-bound frame at every physical mutation boundary', () => {
    expect(swift).toMatch(/case "move":[\s\S]*assertFrameTarget\(frame\)[\s\S]*movePointer/);
    expect(swift).toMatch(/case "click", "double_click":[\s\S]*assertFrameTarget\(frame\)[\s\S]*targetWindow: frameWindow/);
    expect(swift).toMatch(/case "scroll":[\s\S]*assertFrameTarget\(frame\)[\s\S]*event\.post/);
    expect(swift).toMatch(/case "drag":[\s\S]*assertFrameTarget\(frame\)[\s\S]*targetWindow: frameWindow/);
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
    expect(swift).toContain('"displays": displayTopologyObject(displayRects)');
    expect(swift).toContain('active display topology changed after the screenshot');
    expect(computer).toContain('displayTopology: Rect[] | null');
    expect(computer).toContain('displays: frame.displayTopology');
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
