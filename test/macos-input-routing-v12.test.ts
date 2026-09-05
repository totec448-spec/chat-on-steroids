import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (rel: string) => readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const swift = source('native/macos-desktop-helper/main.swift');
const computer = source('src/main/computer/index.ts');
const tools = source('src/main/mcp/tools-desktop.ts');
const instructions = source('src/main/mcp/instructions.ts');
const ci = source('.github/workflows/ci.yml');

describe('macOS Computer Use v16 input routing', () => {
  it('keeps the in-process Electron -> Worker -> N-API -> Swift production boundary', () => {
    expect(computer).toContain('new Worker');
    expect(computer).toContain('MacOSAddonRuntime');
    expect(swift).toContain('#if COS_DESKTOP_ADDON');
    expect(swift).toContain('@_cdecl("cos_desktop_handle_json")');
  });

  it('fails closed for physical mutations without an exact WindowLease', () => {
    expect(computer).toContain('targetWindow?: number');
    expect(computer).toContain('const inferredTargetWindow');
    expect(computer).toContain('const requiresWindowLease');
    expect(computer).toContain('INPUT_TARGET_REQUIRED: physical pointer and application text mutations require targetWindow');
    expect(swift).toContain('var leasedWindow = frameWindow ?? requestedTargetWindow');
    expect(swift).toContain('click input requires targetWindow');
    expect(swift).toContain('scroll input requires targetWindow');
    expect(swift).toContain('drag input requires targetWindow');
    expect(swift).toContain('text input requires targetWindow');
    expect(swift).toContain('keyboard input requires targetWindow');
  });

  it('carries a semantic ref target forward into following keyboard input', () => {
    expect(swift).toMatch(/case "click_ui", "set_value_ui":[\s\S]*leasedWindow = actionWindow[\s\S]*case "type":[\s\S]*targetWindow: target/);
    expect(computer).toContain('{ targetWindow: inferredTargetWindow }');
  });

  it('does not activate a window merely to validate its coordinate frame', () => {
    const validate = swift.slice(swift.indexOf('private func validateFrame'), swift.indexOf('@discardableResult', swift.indexOf('private func validateFrame')));
    expect(validate).not.toContain('focusWindow(windowID)');
    expect(validate).not.toContain('assertFrameTarget(frame)');
  });

  it('exposes closed-loop targetWindow and automatic result capture', () => {
    expect(tools).toContain('targetWindow: windowIdArg.optional()');
    expect(tools).toContain('decisionActions.length > 1');
    expect(tools).toContain('const autoCapture = caps.screen && captureAfter !== false && mutatesDesktop');
    expect(tools).toContain('captureMaxWidth ?? (autoCapture ? 1600 : undefined)');
    expect(computer).toContain('captureFallback');
    expect(computer).toContain('capture.window = result.targetWindow');
    expect(computer).toContain('targetWindow: inferredTargetWindow ?? null');
    expect(instructions).toContain('pass the observed window id as targetWindow');
  });

  it('compiles both real macOS helper architectures in CI', () => {
    expect(ci).toContain('node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch x64');
    expect(ci).toContain('node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch arm64');
  });
});
