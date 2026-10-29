import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyEvidence, type CallEvidence } from '../src/main/mcp/call-context.js';
import { summarizeRunningCall, summarizeToolCall } from '../src/main/session/summarize.js';
import type { ToolOutcome } from '../src/shared/session.js';

/**
 * Tool rows were recorded and shown in English in every language (2.1.47 release round). Every title,
 * detail and metric summarize.ts can word, done, running, failed or refused, is translated where it
 * is shown; a path, command or query in it stays as it was.
 */
const LOCALES = ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'];
let dom: JSDOM;
let titles: typeof import('../src/renderer/tool-titles.js');
let i18n: typeof import('../src/renderer/i18n.js');

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://local.test/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
  i18n = await import('../src/renderer/i18n.js');
  titles = await import('../src/renderer/tool-titles.js');
});
afterAll(() => { i18n.setLanguage('en'); dom.window.close(); });

const evidence = (over: Partial<CallEvidence> = {}): CallEvidence => ({ ...emptyEvidence(), ...over });
const change = (path: string) => ({ path, added: 3, removed: 1, approximate: false });
/** One call of every kind summarize.ts words, with the evidence that picks its wording. */
const CALLS: Array<{ tool: string; args: unknown; evidence?: Partial<CallEvidence> }> = [
  { tool: 'read', args: { paths: ['src/a.ts'], start_line: 1, end_line: 40 } },
  { tool: 'read', args: { paths: ['src/a.ts'], start_line: 7 } },
  { tool: 'read', args: { paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] } },
  { tool: 'read', args: { paths: ['a.ts', 'b.ts'] } },
  { tool: 'find', args: { query: 'TODO', mode: 'content' }, evidence: { count: 3 } },
  { tool: 'find', args: { query: 'TODO', mode: 'content' }, evidence: { count: 1 } },
  { tool: 'find', args: { query: 'TODO' }, evidence: { count: 2 } },
  { tool: 'find', args: { query: 'TODO', mode: 'content' } },
  { tool: 'find', args: { query: 'TODO' } },
  { tool: 'apply_patch', args: { patch: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch' }, evidence: { changes: [change('a.ts')] } },
  { tool: 'apply_patch', args: { patch: '*** Delete File: a.ts' }, evidence: { changes: [change('a.ts')] } },
  { tool: 'apply_patch', args: { patch: '*** Update File: a.ts\n*** Move to: b.ts' }, evidence: { changes: [change('b.ts')] } },
  { tool: 'apply_patch', args: { patch: '*** Update File: a.ts' }, evidence: { changes: [change('a.ts'), change('b.ts')] } },
  { tool: 'apply_patch', args: { patch: '*** Update File: a.ts' } },
  { tool: 'exec_command', args: { cmd: 'npm test' }, evidence: { exitCode: 0, durationMs: 2100 } },
  { tool: 'exec_command', args: { cmd: 'npm test' }, evidence: { exitCode: 0, durationMs: 340 } },
  { tool: 'exec_command', args: { cmd: 'npm test' }, evidence: { exitCode: 0, durationMs: 245_000 } },
  { tool: 'exec_command', args: { cmd: 'npm test' }, evidence: { exitCode: 2, durationMs: 900 } },
  { tool: 'exec_command', args: { cmd: 'npm test' }, evidence: { timedOut: true } },
  { tool: 'exec_command', args: { cmd: 'npm run dev' }, evidence: { running: true } },
  { tool: 'exec_command', args: { cmds: ['npm ci', 'npm test'] }, evidence: { exitCode: 0, durationMs: 1000 } },
  { tool: 'exec_command', args: {}, evidence: { exitCode: 0, durationMs: 10 } },
  { tool: 'write_stdin', args: { session_id: 4, signal: 'kill' }, evidence: { exitCode: 0 } },
  { tool: 'write_stdin', args: { session_id: 4, signal: 'int' }, evidence: { exitCode: 1 } },
  { tool: 'write_stdin', args: { session_id: 4, chars: 'y\n' } },
  { tool: 'write_stdin', args: { session_id: 4 } },
  { tool: 'observe', args: { wait_for: 'Save' } },
  { tool: 'observe', args: { what: 'windows' }, evidence: { count: 4 } },
  { tool: 'observe', args: { what: 'ui', match: 'OK' }, evidence: { count: 2 } },
  { tool: 'observe', args: {}, evidence: { count: 12 } },
  ...['list_windows', 'get_window', 'list_apps', 'get_window_state', 'launch_app', 'click', 'press_key', 'type_text', 'scroll', 'set_value',
    'drag', 'perform_secondary_action', 'activate_window', 'read_clipboard', 'write_clipboard'].map(tool => ({ tool, args: {} })),
  ...['click', 'click_ref', 'set_value', 'double_click', 'move', 'drag', 'scroll', 'type', 'keypress', 'focus', 'wait', 'read_clipboard',
    'write_clipboard', 'swipe'].map(type => ({ tool: 'computer', args: { actions: [{ type }] } })),
  { tool: 'computer', args: { actions: [{ type: 'click' }, { type: 'type' }, { type: 'keypress' }] } },
  { tool: 'computer', args: { actions: [{ type: 'swipe' }, { type: 'type' }] } },
  { tool: 'update_plan', args: { plan: [{ step: 'a', status: 'completed' }, { step: 'b', status: 'pending' }] } },
  { tool: 'update_plan', args: { plan: [] } },
  { tool: 'session', args: { action: 'search', query: 'release' }, evidence: { count: 5 } },
  { tool: 'session', args: { action: 'search' }, evidence: { count: 1 } },
  { tool: 'session', args: { action: 'read', tool_call: 'x' }, evidence: { count: 1 } },
  { tool: 'session', args: { action: 'read', cursor: 'x' }, evidence: { count: 3 } },
  { tool: 'session', args: { action: 'read' } },
  { tool: 'agents', args: { action: 'spawn', workers: [{}, {}] } },
  { tool: 'agents', args: { action: 'spawn', workers: [{}] } },
  { tool: 'agents', args: { action: 'message', messages: [{ to: 'a' }, { to: 'b' }] } },
  { tool: 'agents', args: { action: 'message', to: 'worker-2' } },
  { tool: 'agents', args: { action: 'message' } },
  { tool: 'agents', args: { action: 'finish' } },
  { tool: 'agents', args: { action: 'status' }, evidence: { count: 2 } },
  { tool: 'some_new_tool', args: {} }
];
const OUTCOMES: ToolOutcome[] = ['ok', 'tool_rejected', 'tool_internal_error', 'tool_execution_error'];

/** Every title, detail and metric the app can record, done, running, failed, refused and completed. */
function recorded(): { titles: Set<string>; details: Set<string>; metrics: Set<string> } {
  const found = { titles: new Set<string>(), details: new Set<string>(), metrics: new Set<string>() };
  for (const call of CALLS) {
    found.titles.add(summarizeRunningCall(call.tool, call.args, evidence(call.evidence)).title);
    for (const outcome of OUTCOMES) {
      const summary = summarizeToolCall({ tool: call.tool, args: call.args, evidence: evidence(call.evidence), outcome, durationMs: 1200 });
      found.titles.add(summary.title);
      if (summary.detail) found.details.add(summary.detail);
      if (summary.metric) found.metrics.add(summary.metric);
      // A started process that ends later (session/store.ts completeProcessCall).
      if (summary.title.startsWith('Started ')) {
        found.titles.add(summary.title.replace(/^Started /, 'Completed '));
        found.titles.add(summary.title.replace(/^Started /, 'Command failed '));
      }
    }
  }
  found.titles.add(summarizeToolCall({ tool: 'apply_patch', args: { patch: '' }, evidence: evidence(), outcome: 'tool_rejected', durationMs: 1,
    resultHead: "apply_patch verification failed: Failed to find expected lines in a.ts" }).title);
  for (const metric of ['✓ finished', '✕ exit 3', 'finished (exit unknown)']) found.metrics.add(metric);
  return found;
}

/** What stays as recorded in every language: a line delta, or a title that is only a path or command. */
const AS_RECORDED = /^~?(?:\+\d+)?\s*(?:[−-]\d+)?$/;

describe('tool rows in the person\'s language', () => {
  it('has every phrase in every catalog', () => {
    for (const locale of LOCALES) {
      const catalog = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')) as Record<string, string>;
      const missing = [...titles.TOOL_TITLE_TEMPLATES, ...titles.TOOL_DETAIL_WORDS].filter(key => !Object.hasOwn(catalog, key));
      expect(missing, locale).toEqual([]);
    }
  });

  it.each(LOCALES)('translates every title, detail and metric the app records (%s)', locale => {
    const { titles: shown, details, metrics } = recorded();
    expect(shown.size).toBeGreaterThan(150);
    // Left as recorded here and in a second language: not recognized. (A word can be the same as English in one
    // language, as French "3 actions" is, but not in both.)
    const other = locale === 'de' ? 'fr' : 'de';
    const kept = (local: (text: string) => string) => (text: string): boolean => {
      i18n.setLanguage(locale as never);
      if (local(text) !== text) return false;
      i18n.setLanguage(other as never);
      return local(text) === text;
    };
    expect([...shown].filter(kept(titles.localToolTitle)), locale).toEqual([]);
    expect([...details].filter(kept(titles.localToolDetail)).filter(detail => !/^\/a\.ts, \/b\.ts$/.test(detail)), locale).toEqual([]);
    expect([...metrics].filter(kept(titles.localToolMetric)).filter(metric => !AS_RECORDED.test(metric)), locale).toEqual([]);
  });

  it('keeps the path, command or query of a title as it was recorded', () => {
    i18n.setLanguage('de');
    expect(titles.localToolTitle('Read src/Read me.ts')).toBe(i18n.t('Read {0}', ['src/Read me.ts']));
    expect(titles.localToolTitle('Read src/Read me.ts')).toContain('src/Read me.ts');
    expect(titles.localToolTitle('Searched "Searched recordings"')).toContain('"Searched recordings"');
    expect(titles.localToolTitle('Ran 2 commands: npm ci; npm test')).toContain('npm ci; npm test');
    expect(titles.localToolTitle('Could not read the clipboard')).toBe(i18n.t('Could not read the clipboard'));
    expect(titles.localToolTitle('Failed: Updated the task plan')).toBe(i18n.t('Failed: {0}', [i18n.t('Updated the task plan')]));
    expect(titles.localToolTitle('Clicked and 2 more')).toContain(i18n.t('Clicked'));
    // Anything else, such as a title from a later version, is shown as it came; a search names its query in quotes.
    expect(titles.localToolTitle('Summoned a dragon')).toBe('Summoned a dragon');
    expect(titles.localToolTitle('Searched for prefers-color-scheme')).toBe('Searched for prefers-color-scheme');
    expect(titles.localToolTitle('Could not search "x"')).toBe(i18n.t('Could not search {0}', ['"x"']));
    expect(titles.localToolDetail('ENOENT: no such file')).toBe('ENOENT: no such file');
    expect(titles.localToolMetric('+18 −4')).toBe('+18 −4');
    // Times in the person's units.
    expect(titles.localToolMetric('✓ 2.1s')).toBe(`✓ ${i18n.t('{0}s', ['2,1'])}`);
    expect(titles.localToolMetric('✓ 4m 5s')).toBe(`✓ ${i18n.t('{0}m', [4])} ${i18n.t('{0}s', [5])}`);
    i18n.setLanguage('en');
    // English reads exactly as recorded.
    for (const title of recorded().titles) expect(titles.localToolTitle(title)).toBe(title);
    for (const metric of recorded().metrics) expect(titles.localToolMetric(metric)).toBe(metric);
    for (const detail of recorded().details) expect(titles.localToolDetail(detail)).toBe(detail);
  });

  // CodeRabbit on #1918: the open Activity view of a sub-agent follows a change of language too.
  it('repaints a sub-agent\'s Activity rows when the language changes', async () => {
    i18n.setLanguage('en');
    const { renderWorkerActivity } = await import('../src/renderer/agent-activity.js');
    const call = { seq: 1, time: 1_000, source: 'mcp', kind: 'tool_call', call: { callId: 'c-1', tool: 'read', attribution: 'request_id', outcome: 'ok', durationMs: 5,
      args: { text: '{}', truncated: false, chars: 2 }, result: { text: '', truncated: false, chars: 0 },
      summary: { kind: 'read', tone: 'neutral', title: 'Read src/a.ts', detail: 'lines 1–40', metric: '40 lines' } } };
    const nodes = renderWorkerActivity([call as never], 'Check the file');
    document.body.replaceChildren(...nodes);
    const row = document.querySelector<HTMLElement>('.agent-activity-row')!;
    const shown = () => ({ title: row.querySelector('.agent-activity-title')!.firstChild!.textContent, detail: row.querySelector('em')!.textContent,
      metric: row.querySelector('.agent-activity-metric')!.textContent, tooltip: row.title });
    expect(shown()).toEqual({ title: 'Read src/a.ts', detail: 'lines 1–40', metric: '40 lines', tooltip: 'Read src/a.ts · lines 1–40 · 40 lines' });
    i18n.setLanguage('de');
    expect(shown().title).toBe(i18n.t('Read {0}', ['src/a.ts']));
    expect(shown().detail).toBe(i18n.t('lines {0}–{1}', ['1', '40']));
    expect(shown().metric).toBe(i18n.tn('{0} line', '{0} lines', 40));
    expect(shown().tooltip).toContain(i18n.t('Read {0}', ['src/a.ts']));
    i18n.setLanguage('en');
  });
});
