import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }));
vi.mock('../src/main/config.js', () => ({
  getConfig: () => ({
    roots: [{ name: 'ClientWork', path: '/Users/jane/Clients/Acme Corp' }],
    tunnel: { kind: 'openai', profileName: 'Jane Personal', tunnelId: 'tun_8f3k2m9q', desktopTunnelId: '', binaryPath: '/Users/jane/bin/cloudflared' },
    ui: { theme: 'dark', language: 'de', browserOnly: false, autoContinue: true, chatBrowser: 'chrome' },
    multiAgent: { enabled: true, maxWorkers: 4, defaultReasoning: 'high' },
    compaction: { autoTokens: 400000, handoffPrompt: 'Summarize my private project notes' },
    goal: { provider: { baseUrl: 'https://llm.jane-home.net/v1' } }
  })
}));

const { renderDiagnosticsReport, reportableSettings } = await import('../src/main/diagnostics-report.js');

const personal = ['jane', 'Clients', 'Acme', 'ClientWork', 'Jane Personal', 'tun_8f3k2m9q', 'cloudflared', 'private project notes',
  'jane-home', 'Rebuild budget model', 'Audit the Q3 invoices', 'jane.doe@example.com', 'invoices.xlsx', 'Steuer'];

const sources = {
  app: { version: '2.1.27', electron: '44.3.0', chrome: '146.0', platform: 'darwin', arch: 'arm64', osRelease: '27.0.0', locale: 'de-DE' },
  home: '/Users/jane',
  bridge: { running: true, port: 8765, paired: true, present: true, lastSeenAt: 1, extensionVersion: '2.1.27' },
  extension: null,
  selfTest: { summary: 'All checks passed', checks: [{ name: 'Local MCP server', status: 'pass', detail: 'answered in 12 ms' }] },
  commands: [{ command: 'c1', what: 'worker:run-1:worker-2', lastError: null }],
  workers: [{ worker: 'worker-2', role: 'worker', state: 'invited', model: 'gpt-5-5', reasoningEffort: 'high', conversationId: null }],
  sessions: [{ title: 'Rebuild budget model', lastToolActivity: { title: 'Steuer 2025' }, endedAt: null, toolCalls: 3 }],
  projects: [{ name: 'ClientWork', path: '/Users/jane/Clients/Acme Corp' }],
  workerTexts: ['Audit the Q3 invoices'],
  log: [
    '2026-10-04T06:48:22.158Z  info   multi-agent: created 1 worker(s) in run 6c578026-18d5-4efe-8c88-c63da86e6b3c',
    "2026-10-04T06:48:23.000Z  warn   tool read rejected in 3 ms: ENOENT, open '/Users/jane/Clients/Acme Corp/invoices.xlsx'",
    '2026-10-04T06:48:24.000Z  info   approved folder /ClientWork',
    '2026-10-04T06:48:25.000Z  info   worker-2 task: Audit the Q3 invoices for jane.doe@example.com',
    '2026-10-04T06:49:53.818Z  warn   bridge: gave up on worker:6c578026-18d5-4efe-8c88-c63da86e6b3c:worker-2 — the chat this app opened did not report back in time'
  ].join('\n'),
  now: Date.UTC(2026, 9, 4, 7, 0)
};

describe('the diagnostics report', () => {
  it('contains no personal detail from any source', () => {
    const report = renderDiagnosticsReport(sources);
    for (const value of personal) expect(report.toLowerCase(), value).not.toContain(value.toLowerCase());
  });

  it('keeps what explains the failure', () => {
    const report = renderDiagnosticsReport(sources);
    expect(report).toContain('Version: 2.1.27');
    expect(report).toContain('darwin 27.0.0 (arm64)');
    expect(report).toContain('"extensionVersion": "2.1.27"');
    expect(report).toContain('Local MCP server: pass');
    expect(report).toContain('worker:run-1:worker-2');
    expect(report).toContain('gave up on worker:6c578026-18d5-4efe-8c88-c63da86e6b3c:worker-2 — the chat this app opened did not report back in time');
    expect(report).toContain('ui.theme: dark');
    expect(report).toContain('multiAgent.maxWorkers: 4');
    expect(report).toContain('compaction.autoTokens: 400000');
    expect(report).toContain('1 chat(s), 0 ended, 1 project(s)');
  });

  it('scrubs Windows paths inside JSON sections, where backslashes are doubled', () => {
    const report = renderDiagnosticsReport({ ...sources, home: 'C:\\Users\\Jane',
      commands: [{ command: 'c2', what: 'worker:run-1:worker-3', lastError: 'spawn C:\\Users\\Jane\\bin\\codex.exe ENOENT' }],
      extension: { status: { pairError: { error: 'x', message: 'cannot read D:\\Kunden\\Acme GmbH\\vertrag.pdf' } } } });
    for (const leaked of ['Jane', 'codex.exe', 'Kunden', 'Acme', 'vertrag']) expect(report, leaked).not.toContain(leaked);
    expect(report).toContain('worker:run-1:worker-3');
  });

  it('reports settings as on/off values, numbers and option names only', () => {
    const lines = reportableSettings({ ui: { theme: 'dark', followOutput: true }, roots: [{ path: '/x' }], tunnel: { tunnelId: 't' },
      compaction: { handoffPrompt: 'secret words' }, custom: { note: 'two words' } });
    expect(lines).toEqual(['ui.theme: dark', 'ui.followOutput: true']);
  });
});
