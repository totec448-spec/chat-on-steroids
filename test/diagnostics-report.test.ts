import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, dialog: {}, shell: {} }));
vi.mock('../src/main/config.js', () => ({
  getConfig: () => ({
    connectorSuffix: 'Janes-MacBook',
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
  'jane-home', 'Rebuild budget model', 'Audit the Q3 invoices', 'jane.doe@example.com', 'invoices.xlsx', 'Steuer', 'Janes-MacBook', 'MacBook'];

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
    '2026-10-04T06:48:24.500Z  info   plugin refresh: Chat On Steroids Core (Janes-MacBook) is current',
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

  // 2026-10-15, user: more of what a first answer needs, still nothing personal.
  it('adds install, system, crash, error, tool and chat facts, with error samples scrubbed like the log', () => {
    const report = renderDiagnosticsReport({ ...sources, facts: {
      install: ['Installed as: macOS app in /Applications (packaged)'],
      system: ['Memory: 16.0 GB total, 3.5 GB free'],
      crashes: ['Crash reports in the last 30 days: 0'],
      errors: ["3× warn 10:00–10:05 UTC: tool read rejected: ENOENT, open '/Users/jane/Clients/Acme Corp/invoices.xlsx'"],
      tools: ['read: 3 call(s), 1 error(s), 0 timeout(s), median 20 ms'],
      chats: ['#1 main chat: active 5 min ago, 12 tool call(s), 0 failed command(s), 0 refused, inputs: none']
    } });
    for (const heading of ['## Install and updates', '## System', '## Crashes and restarts', '## Most frequent warnings and errors since start',
      '## Tool calls (last 24 hours)', '## Active chats']) expect(report).toContain(heading);
    expect(report).toContain('read: 3 call(s), 1 error(s)');
    expect(report).toContain('3× warn 10:00–10:05 UTC: tool read rejected: ENOENT');
    for (const value of personal) expect(report.toLowerCase(), value).not.toContain(value.toLowerCase());
  });

  it('says which browser runs ChatGPT, its tabs by state and which page controls were found', () => {
    const report = renderDiagnosticsReport({ ...sources, extension: { status: {}, environment: {
      browser: { name: 'Google Chrome', version: '154.0.7400.12' },
      tabs: { open: 5, discarded: 1, frozen: 1, loading: 0, grouped: 2, inBackgroundWindow: 0 },
      page: { composer: true, sendArea: true, modelMenu: false, plusMenu: true, language: 'de-DE' } } } });
    expect(report).toContain('## Browser and ChatGPT page');
    expect(report).toContain('Browser: Google Chrome 154.0.7400.12');
    expect(report).toContain('ChatGPT tabs: 5 open, 1 discarded, 1 frozen, 0 loading, 2 in a tab group, 0 in the app\'s background window');
    expect(report).toContain('Page checks (most recently used ChatGPT tab): composer found, send area found, model menu NOT found, + menu found, page language de-DE');
    const none = renderDiagnosticsReport({ ...sources, extension: { status: {}, environment: { browser: { name: 'Firefox', version: '144.0' },
      tabs: { open: 0, discarded: 0, frozen: 0, loading: 0, grouped: 0, inBackgroundWindow: 0 }, page: null } } });
    expect(none).toContain('Page checks: no awake ChatGPT tab answered');
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
      compaction: { handoffPrompt: 'secret words' }, custom: { note: 'two words' }, connectorSuffix: 'Janes-MacBook' });
    expect(lines).toEqual(['ui.theme: dark', 'ui.followOutput: true']);
  });

  // #1312: "7 GB with only 3 workers" could not be answered from the report: it did not say what
  // the memory was in. Numbers only, so nothing personal can be in it.
  it('says where the memory is: ChatGPT pages, the app window, and the rest', () => {
    const report = renderDiagnosticsReport({ ...sources, memory: [
      { kind: 'main', megabytes: 131.5 }, { kind: 'window', megabytes: 1841.8 }, { kind: 'gpu', megabytes: 164.2 },
      { kind: 'chatgpt', megabytes: 443.5 }, { kind: 'chatgpt', megabytes: 979.8 }, { kind: 'chatgpt', megabytes: 627.4 },
      { kind: 'page', megabytes: 94 }, { kind: 'other', megabytes: 26.2 }, { kind: 'other', megabytes: 23.6 }
    ] });
    const memory = report.slice(report.indexOf('## Memory'), report.indexOf('## Chats'));
    expect(memory).toContain('Total: 4332 MB in 9 processes');
    // Largest first, so one runaway page stands out.
    expect(memory).toContain('ChatGPT pages in the built-in browser (3): 2051 MB — 980, 627, 444');
    expect(memory).toContain('App window: 1842 MB');
    expect(memory).toContain('Main process: 132 MB');
    expect(memory).toContain('Graphics: 164 MB');
    expect(memory).toContain('Other pages (1): 94 MB');
    expect(memory).toContain('Helpers (2): 50 MB');
  });

  it('leaves the memory section out when the system reports nothing', () => {
    expect(renderDiagnosticsReport(sources)).not.toContain('## Memory');
    expect(renderDiagnosticsReport({ ...sources, memory: [] })).not.toContain('## Memory');
  });
});
