import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (rel: string) => readFileSync(path.join(root, ...rel.split('/')), 'utf8');

describe('open upstream issue hardening bundle', () => {
  /**
   * Both parsers keep the same shape, so a tab URL and the page's own route can never
   * disagree about which conversation a document is on. What each pattern accepts and
   * rejects is covered behaviourally in extension.test.ts and content-script.test.ts;
   * this only holds the two copies together.
   */
  it('recognises normal and Project ChatGPT conversation routes', () => {
    const dom = source('extension/chatgpt-dom.js');
    const worker = source('extension/background.js');
    expect(dom).toContain("/^\\/(?:g\\/[^/]+\\/)?c\\/([0-9a-f-]{8,64})(?:\\/|$)/i");
    expect(worker).toContain("/^\\/(?:g\\/[^/]+\\/)?c\\/([0-9a-f-]{8,64})(?:\\/|$)/i");
    expect(source('extension/content.js')).toContain('CLF_DOM.conversationFromPath(path)');
  });

  /**
   * Firefox stays a target for everything except browser control, which needs the DevTools
   * protocol Firefox does not expose to extensions. That one feature declares itself
   * unavailable and hides its own switch there; recording, the bridge, Overwrite and the
   * relabeller never touch the debugger API and work exactly as they do in Chrome.
   */
  it('keeps the Chrome MV3 manifest valid while retaining Firefox runtime compatibility hooks', () => {
    const manifest = JSON.parse(source('extension/manifest.json'));
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(121);
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.background).not.toHaveProperty('scripts');
    expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe('128.0');
    expect(source('extension/background.js')).toContain('globalThis.browser ?? globalThis.chrome');
    expect(source('src/main/bridge.ts')).toContain("origin.startsWith('moz-extension://')");
    // The one capability that cannot exist there refuses by feature, not by browser name.
    expect(source('extension/browser-driver.js')).toContain('export function browserControlSupported()');
  });

  it('keeps a browser-proven compaction capture out of recursive auto-compaction', () => {
    const content = source('extension/content.js');
    const continuation = source('src/main/session/continuation.ts');
    expect(content).toContain('if (compactCapture || nativeBusy || pressedAt > 0 || localError) return;');
    expect(content).toContain('compactToken: compactCapture.token');
    expect(continuation).toContain('export function touchContinuation');
    expect(continuation).toContain('now - entry.touchedAt >= CONTINUATION_TTL_MS');
  });

  it('projects returned background exec lifecycle separately from pending MCP handlers', () => {
    const bridge = source('src/main/bridge.ts');
    const exec = source('src/main/codex/unified-exec.ts');
    const content = source('extension/content.js');
    expect(bridge).toContain('backgroundExec: backgroundExecForConversation');
    expect(exec).toContain('backgroundState(processId: number)');
    expect(content).toContain('exitedUnread');
    expect(content).toContain("entry.kind === 'agent_message'");
  });

  it('does not classify a bare local timeout as a control-plane outage', () => {
    const tunnel = source('src/main/tunnel/index.ts');
    expect(tunnel).toContain('CONTROL_PLANE_POLL');
    expect(tunnel).toContain('UNREACHABLE_NETWORK');
    expect(tunnel).toContain('interface ClientRun');
    expect(tunnel).toContain('stopped || current !== run');
    expect(tunnel).toContain('showUnknown');
  });

  it('scopes privacy history to the checked-out line and keeps fork inheritance buildable', () => {
    const verify = source('scripts/verify-public-history.mjs');
    expect(verify).not.toContain("runGit(['rev-list', '--all'])");
    expect(verify).toContain("runGit(['rev-list', 'HEAD'])");
    expect(verify).toContain("runGit(['tag', '--merged', 'HEAD', '--list'])");
    expect(verify).toContain('enforceHistoricalMaintainerIdentity');
  });
});
