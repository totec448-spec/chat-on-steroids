import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (rel: string) => readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const swift = source('native/macos-desktop-helper/main.swift');
const content = source('extension/content.js');
const dom = source('extension/chatgpt-dom.js');
const popup = source('extension/popup.js');
const popupHtml = source('extension/popup.html');
const packageJson = source('package.json');

describe('macOS review v16 plus retained worker-draft hardening', () => {
  it('keeps the current native safety boundaries and removes the undeclared Electron wrapper', () => {
    expect(swift).toContain('AXUIElementSetMessagingTimeout');
    expect(swift).toContain('sameDisplayTopology');
    expect(swift).toContain('maxEncodedScreenshotBytes');
    expect(swift).toContain('private func isSystemShortcut');
    expect(swift).toContain('["volumeup", "volumedown", "mute"]');
    expect(packageJson).not.toContain('"verify:ci": "install-electron --no');
  });

  it('offers the persistent opt-in Replace worker drafts setting that defaults off', () => {
    expect(popupHtml).toContain('id="replaceDraftToggle"');
    expect(popupHtml).toContain('Replace worker drafts');
    expect(popupHtml).not.toContain('id="replaceDraftToggle" type="checkbox" checked');
    expect(popup).toContain("const REPLACE_WORKER_DRAFTS_KEY = 'replaceWorkerDrafts'");
    expect(popup).toContain('stored[REPLACE_WORKER_DRAFTS_KEY] === true');
    expect(popup).toContain('webext.storage.local.set({ [REPLACE_WORKER_DRAFTS_KEY]: replaceWorkerDrafts })');
  });

  it('only replaces a draft on a redeemed fresh bootstrap and verifies exact text before Send', () => {
    expect(content).toContain('const RECORDER_VERSION = 11');
    expect(content).toContain("(boot.type === 'worker' || boot.type === 'resume')");
    expect(content).toContain('replaceExistingDraft = await replaceWorkerDraftsEnabled()');
    expect(content).toContain("if (!CLF_DOM.insertPrompt(boot.text, replaceExistingDraft))");
    expect(content).toContain('waitForRevivalSubmitReady(openedConversation, attempt)');
    expect(content).toContain("the composer changed before bootstrap send; the draft was preserved");
    expect(dom).toContain('function insertPrompt(value, mode = false)');
    expect(dom).toContain('box.replaceChildren()');
  });
});
