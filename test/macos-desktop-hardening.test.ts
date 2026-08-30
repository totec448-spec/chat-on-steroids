import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const swift = readFileSync(path.join(process.cwd(), 'native/macos-desktop-helper/main.swift'), 'utf8');
const preparation = readFileSync(path.join(process.cwd(), 'scripts/prepare-macos-desktop-helper.mjs'), 'utf8');

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

  it('keeps the installed SDK availability guard on ScreenCaptureKit dimensions', () => {
    expect(swift).toContain('The current SDK marks these setters macOS 13+');
    expect(swift).toMatch(/if #available\(macOS 13\.0, \*\) \{\s*configuration\.width = width\s*configuration\.height = height/);
  });
});
