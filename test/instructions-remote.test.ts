import { expect, it } from 'vitest';
import { serverInstructions } from '../src/main/mcp/instructions.js';
import { DEFAULT_CAPABILITIES } from '../src/shared/types.js';

// #1469: the model has to know which folders are on another computer: commands run there, and the
// paths it sees in their output are that computer's.
it('marks a folder on a server and says what that means, only when there is one', () => {
  const base = { caps: { ...DEFAULT_CAPABILITIES, command: true }, readOnly: false, sessionTools: false, agentTools: false } as const;
  const local = serverInstructions({ ...base, roots: [{ name: 'work', path: '/tmp' }] } as any, 'core', 'darwin');
  expect(local).not.toMatch(/\(server/);
  expect(local).not.toMatch(/SSH/);
  const remote = serverInstructions({ ...base, roots: [{ name: 'work', path: '/tmp' }, { name: 'app', path: 'dev:/srv/app', remote: { host: 'dev', path: '/srv/app' } }] } as any, 'core', 'darwin');
  expect(remote).toContain('/app (server dev)');
  expect(remote).toMatch(/\(server\) folder is on another computer over SSH/);
  expect(remote.length - local.length).toBeLessThan(400);
});
