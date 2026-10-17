import { expect, it, vi } from 'vitest';

// #1469: a folder on a server is saved as `host:path`, but the log quotes the host alone (ssh's
// errors) and the server path alone (pwd, tool errors). Both identify the person's machines.
const remote = { host: 'deploy@acme-build.internal', port: 2222, path: '/srv/acme-billing' };
vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }));
vi.mock('../src/main/config.js', () => ({
  getConfig: () => ({ roots: [{ name: 'acme-billing', path: `${remote.host}:${remote.path}`, remote }], tunnel: {}, ui: {} })
}));

const { renderDiagnosticsReport } = await import('../src/main/diagnostics-report.js');

it('replaces the server, its user and the server folder wherever the log quotes them', () => {
  const report = renderDiagnosticsReport({
    app: { version: '2.1.40', electron: '44.3.0', chrome: '146.0', platform: 'darwin', arch: 'arm64', osRelease: '27.0.0', locale: 'en-US' },
    home: '/Users/you', bridge: { running: true, port: 8765, paired: true, present: true, lastSeenAt: 1, extensionVersion: '2.1.40' },
    extension: null, selfTest: { summary: 'All checks passed', checks: [] }, commands: [], workers: [], sessions: [], workerTexts: [],
    projects: [{ name: 'acme-billing', path: `${remote.host}:${remote.path}` }],
    log: [
      '2026-10-16T09:00:00.000Z  warn   tool exec_command failed: deploy@acme-build.internal: Permission denied (publickey).',
      '2026-10-16T09:00:01.000Z  warn   ssh: connect to host acme-build.internal port 2222: Connection refused',
      "2026-10-16T09:00:02.000Z  warn   tool read rejected: No such file: '/srv/acme-billing/config/prod.env'"
    ].join('\n'),
    now: Date.UTC(2026, 9, 16, 10, 0)
  } as any);
  for (const value of ['acme-build', 'deploy@', 'acme-billing', '/srv/acme']) expect(report, value).not.toContain(value);
  expect(report).toContain('Permission denied (publickey)');
});
