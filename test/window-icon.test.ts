import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserWindowIconPath } from '../src/main/window-icon.js';

describe('native BrowserWindow icon policy', () => {
  it('uses the packaged branded runtime PNG on Linux', () => {
    expect(browserWindowIconPath('linux', true, '/opt/chat/resources')).toBe(
      path.join('/opt/chat/resources', 'runtime-icon.png')
    );
  });

  it.each(['win32', 'darwin'] as const)('preserves native executable/bundle icon semantics on %s', (platform) => {
    expect(browserWindowIconPath(platform, true, '/irrelevant/resources')).toBeUndefined();
  });

  it('does not impose a generated packaging path on Linux development runs', () => {
    expect(browserWindowIconPath('linux', false, '/electron/resources')).toBeUndefined();
  });
});
