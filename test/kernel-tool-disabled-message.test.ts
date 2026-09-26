/**
 * `toolDisabledMessage` naming the actual switch to flip.
 *
 * Two readings of the same defect, kept together: through `guarded()`, which is the call site
 * that has never passed a `settingLabel`, and on the function itself, where the label default
 * and the Read-only override are decided. QA measured `observe` refused with Desktop switched
 * off — "is disabled by the current Chat On Steroids permissions. Ask the user to enable the
 * permission in the app" — which names nothing. Read-only already named itself; the
 * plain-capability branch did not.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRegistrar, ok, toolDisabledMessage } from '../src/main/mcp/kernel.js';
import { DEFAULT_CAPABILITIES, WRITE_CAPABILITIES, type Capability } from '../src/shared/types.js';

function registrar(readOnly: boolean, enabled: Partial<Record<Capability, boolean>> = {}) {
  return createRegistrar(null, {
    roots: [], readOnly, caps: { ...DEFAULT_CAPABILITIES, ...enabled },
    sessionTools: false, agentTools: false
  }, 'core');
}

it('names the actual Settings permission when a capability is revoked', async () => {
  const tools = registrar(false, { screen: true });
  const action = vi.fn(async () => ok('observed'));
  expect(await tools.guarded('screen', 'observe', action)).toEqual(ok('observed'));
  tools.caps.screen = false;
  action.mockClear();
  const result = await tools.guarded('screen', 'observe', action);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('enable \\"See the screen\\"');
  expect(action).not.toHaveBeenCalled();
});

it.each(WRITE_CAPABILITIES)('explains the Read-only override for %s without running it', async cap => {
  const action = vi.fn(async () => ok('changed'));
  const result = await registrar(true, { [cap]: false }).guarded(cap, 'mutation', action);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('Read-only mode is on');
  expect(JSON.stringify(result)).toContain('turn Read-only off');
  expect(action).not.toHaveBeenCalled();
});

it('does not blame Read-only for a disabled read permission or block an allowed read', async () => {
  const tools = registrar(true, { screen: false, read: true });
  const blocked = await tools.guarded('screen', 'observe', async () => ok('unexpected'));
  expect(JSON.stringify(blocked)).toContain('See the screen');
  expect(JSON.stringify(blocked)).not.toContain('Read-only');
  expect(await tools.guarded('read', 'read', async () => ok('contents'))).toEqual(ok('contents'));
});

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
