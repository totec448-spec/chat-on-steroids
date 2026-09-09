/**
 * `toolDisabledMessage` naming the actual switch to flip.
 *
 * QA measured `observe` refused with Desktop switched off — `guarded()` is the one call site
 * that has never passed a `settingLabel` — and got "is disabled by the current Chat On Steroids
 * permissions. Ask the user to enable the permission in the app", which names nothing. Read-only
 * already gets a message that names itself; the plain-capability branch did not.
 */
import { describe, expect, it } from 'vitest';
import { toolDisabledMessage } from '../src/main/mcp/kernel.js';

describe('toolDisabledMessage', () => {
  it("names the capability's own Settings label when the caller supplies none", () => {
    const message = toolDisabledMessage(false, 'screen', 'observe');
    expect(message).toContain('enable "See the screen"');
    expect(message).not.toContain('enable the permission');
  });

  it('still honours an explicit label over the capability default', () => {
    // apply_patch's own call site passes 'changing files' deliberately, since the tool
    // covers create/edit/move/delete together and 'create files' alone would be too narrow.
    const message = toolDisabledMessage(false, 'create', 'apply_patch', 'changing files');
    expect(message).toContain('enable "changing files"');
    expect(message).not.toContain('Create files');
  });

  it('keeps naming Read-only, not the individual capability, when Read-only is what disabled it', () => {
    const message = toolDisabledMessage(true, 'control', 'browser');
    expect(message).toContain('Read-only mode is on');
    expect(message).not.toContain('Control mouse and keyboard');
  });
});
