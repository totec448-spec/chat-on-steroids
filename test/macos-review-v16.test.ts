import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (rel: string) => readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const swift = source('native/macos-desktop-helper/main.swift');
const content = source('extension/content.js');
const dom = source('extension/chatgpt-dom.js');
const packageJson = source('package.json');

describe('macOS review v16 and bootstrap send safety', () => {
  it('keeps the current native safety boundaries and removes the undeclared Electron wrapper', () => {
    expect(swift).toContain('AXUIElementSetMessagingTimeout');
    expect(swift).toContain('sameDisplayTopology');
    expect(swift).toContain('maxEncodedScreenshotBytes');
    expect(swift).toContain('private func isSystemShortcut');
    expect(swift).toContain('["volumeup", "volumedown", "mute"]');
    expect(packageJson).not.toContain('"verify:ci": "install-electron --no');
  });

  it('replaces a stale bootstrap draft and verifies the exact text before Send', () => {
    expect(content).toContain('const RECORDER_VERSION = 11');
    // Unattended startup owns the composer on a redeemed command page: 2.0.6 settled this as
    // an unconditional replace, so what protects the user is the send-time check below, not a
    // refusal to write. See issue #30 for the setting that was proposed and not taken.
    expect(content).toContain('CLF_DOM.insertPrompt(boot.text, true)');
    expect(content).toContain('waitForRevivalSubmitReady(openedConversation, attempt)');
    expect(content).toContain('the composer changed before bootstrap send; the draft was preserved');
    expect(dom).toContain('function insertPrompt(value, mode = false)');
    expect(dom).toContain('box.replaceChildren()');
  });
});
