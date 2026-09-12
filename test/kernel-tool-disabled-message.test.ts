import { expect, it, vi } from 'vitest';
import { createRegistrar, ok } from '../src/main/mcp/kernel.js';
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
