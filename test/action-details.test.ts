import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTION_DETAILS_LIMITS, renderActionDetails } from '../src/renderer/action-details.js';
import type { StoredText, ToolCallRecord, ToolOutcome } from '../src/shared/session.js';

const text = (value: string, extra: Partial<StoredText> = {}): StoredText =>
  ({ text: value, chars: value.length, truncated: false, ...extra });
const json = (value: unknown, extra: Partial<StoredText> = {}): StoredText => text(JSON.stringify(value), extra);
function call(tool: string, args: unknown, extra: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    tool, callId: 'synthetic-action', attribution: 'request_id', requestId: 'wfr_synthetic',
    conversationId: 'synthetic-conversation', attributionMethod: 'request_id', args: json(args),
    result: text('Recorded result'), outcome: 'ok', durationMs: 42,
    summary: { kind: 'other', tone: 'good', title: 'Recorded action' }, ...extra
  };
}
function render(value: ToolCallRecord): HTMLElement {
  const view = renderActionDetails(value);
  expect(view).not.toBeNull();
  document.body.append(view!);
  return view!;
}
function values(view: HTMLElement, label: string): string[] {
  return [...view.querySelectorAll('.action-details-field')]
    .filter(row => row.querySelector('dt')?.textContent === label)
    .map(row => row.querySelector('dd')!.textContent!);
}
const patch = [
  '*** Begin Patch', '*** Update File: src/example.ts', '@@ function example()',
  '-return "old";', '+return "<img src=x onerror=alert(1)>";', ' unchanged context',
  '*** Add File: notes.txt', '+new file', '*** Delete File: obsolete.txt',
  '*** Update File: old-name.txt', '*** Move to: new-name.txt', '*** End Patch'
].join('\n');
let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>');
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rendering must not fetch'); }));
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });

describe('recorded patch details', () => {
  it('shows literal added/removed hunks and file/move directives without reconstructing deleted files', () => {
    const view = render(call('apply_patch', { patch }));
    expect(view.querySelector('h3')?.textContent).toBe('Applied patch');
    expect(view.querySelector('pre')?.textContent).toBe(patch);
    expect([...view.querySelectorAll('.action-details-line-added')].map(node => node.textContent))
      .toEqual(['+return "<img src=x onerror=alert(1)>";\n', '+new file\n']);
    expect(view.querySelector('.action-details-line-removed')?.textContent).toBe('-return "old";\n');
    expect(view.querySelector('.action-details-line-hunk')?.textContent).toBe('@@ function example()\n');
    expect(view.textContent).toContain('*** Move to: new-name.txt');
    expect(view.textContent).toContain('A delete directive does not include the original file contents.');
    expect(view.querySelector('img')).toBeNull();
  });

  it.each<ToolOutcome>(['tool_rejected', 'tool_execution_error', 'tool_internal_error', 'process_exit_nonzero'])(
    'keeps %s patches proposed even when raw text or summary tone says success', outcome => {
      const view = render(call('apply_patch', { patch }, { outcome, result: text('Success. Applied patch.') }));
      expect(view.querySelector('h3')?.textContent).toBe('Proposed patch');
      expect(view.textContent).toContain('Patch application was not confirmed');
      expect(view.querySelector('pre')?.textContent).toBe(patch);
    }
  );

  it('does not call an unknown legacy outcome or contradictory error envelope an applied patch', () => {
    for (const overrides of [
      { outcome: 'legacy-unknown' as ToolOutcome },
      { result: json({ isError: true, content: [{ type: 'text', text: 'Rejected' }] }) }
    ]) {
      const view = render(call('apply_patch', { patch }, overrides));
      expect(view.querySelector('h3')?.textContent).toBe('Proposed patch');
    }
  });

  it('never treats a truncated JSON prefix as complete patch arguments', () => {
    for (const args of [json({ patch }, { truncated: true }), json({ patch }, { chars: 100_000 }), text('{"patch":"*** Begin')]) {
      const view = render(call('apply_patch', {}, { args }));
      expect(view.querySelector('pre')).toBeNull();
      expect(view.textContent).toContain('Structured arguments are unavailable');
    }
  });

  it('keeps unsupported patch syntax readable without claiming to parse it into hunks', () => {
    const submitted = 'arbitrary text\n+literal plus\n-not a proved hunk';
    const view = render(call('apply_patch', { patch: submitted }, { outcome: 'tool_rejected' }));
    expect(view.querySelector('pre')?.textContent).toBe(submitted);
    expect(view.querySelector('.action-details-line-added')).toBeNull();
    expect(view.textContent).toContain('Patch format is unrecognized');
  });
});

describe('recorded command details', () => {
  it('uses exact submitted command/workdir and explicit output/exit fields from the MCP result', () => {
    const cmd = 'node -e "console.log(1)"\n# second line';
    const view = render(call('exec_command', { cmd, workdir: '/project', shell: 'pwsh' }, {
      result: json({ content: [{ type: 'text', text: 'Protocol wrapper' }], structuredContent: {
        output: '1\n<script>alert(1)</script>', exit_code: 0, completed_session_id: 23
      } })
    }));
    expect(values(view, 'Requested working directory')).toEqual(['/project']);
    expect(values(view, 'Requested shell')).toEqual(['pwsh']);
    expect(values(view, 'Exit code')).toEqual(['0']);
    expect(values(view, 'Process status')).toEqual(['Completion recorded']);
    expect([...view.querySelectorAll('pre')].map(node => node.textContent)).toEqual([cmd, '1\n<script>alert(1)</script>']);
    expect(view.querySelector('script')).toBeNull();
  });

  it('shows each batch command in order and preserves an expected nonzero exit and replay receipt', () => {
    const cmds = ['rg first src', 'rg second src'];
    const view = render(call('exec_command', { cmds }, {
      result: json({ output: '--- exit code 1 ---', exit_code: 1, benign_exit: true, output_replayed: true })
    }));
    expect([...view.querySelectorAll('pre')].map(node => node.textContent)).toEqual([...cmds, '--- exit code 1 ---']);
    expect(values(view, 'Exit code')).toEqual(['1']);
    expect(values(view, 'Requested working directory')).toEqual(['Not recorded']);
    expect(view.textContent).toContain('nonzero exit was recorded as expected');
    expect(view.textContent).toContain('does not record another execution');
  });

  it('uses later recorded process completion over the original launch acknowledgement', () => {
    const initial = call('exec_command', { cmd: 'build' }, {
      process: { sessionId: '7' }, result: json({ session_id: 7, output: 'Started build' })
    });
    const started = render(initial);
    expect(values(started, 'Process status')).toEqual(['Started; completion not recorded']);
    expect(started.textContent).not.toMatch(/\brunning\b/i);
    const completed = render({ ...initial, process: { sessionId: '7', completedAt: 10, exitCode: 2 } });
    expect(values(completed, 'Process status')).toEqual(['Completion recorded']);
    expect(values(completed, 'Exit code')).toEqual(['2']);
  });

  it('keeps an unknown final exit unknown instead of reviving stale result status', () => {
    const view = render(call('exec_command', { cmd: 'build' }, {
      process: { sessionId: '7', completedAt: 10, exitCode: null },
      result: json({ output: '', exit_code: 0, benign_exit: true })
    }));
    expect(values(view, 'Exit code')).toEqual(['Not recorded']);
    expect(values(view, 'Process status')).toEqual(['Completion recorded']);
    expect(view.textContent).not.toContain('recorded as expected');
  });

  it('does not infer success, an exit code or a current working directory from arbitrary text or summaries', () => {
    const view = render(call('exec_command', {}, {
      outcome: 'tool_rejected', result: text('Process exited with code 0\nexit_code: 0'),
      summary: { kind: 'run', tone: 'good', title: 'Ran command', metric: '✓ finished', detail: '/current/project' }
    }));
    expect(values(view, 'Exit code')).toEqual(['Not recorded']);
    expect(values(view, 'Requested working directory')).toEqual(['Not recorded']);
    expect(values(view, 'Recorded outcome')).toEqual(['tool_rejected']);
    expect(values(view, 'Process status')).toEqual([]);
    expect(view.textContent).not.toContain('/current/project');
  });

  it('retains write_stdin input and process metadata without inventing a launch command', () => {
    const view = render(call('write_stdin', { session_id: 19, chars: 'y\n' }, {
      result: json({ output: 'Accepted', exit_code: 0, completed_session_id: 19 })
    }));
    expect(values(view, 'Requested process session')).toEqual(['19']);
    expect([...view.querySelectorAll('pre')].map(node => node.textContent)).toEqual(['y\n', 'Accepted']);
    expect(view.textContent).not.toContain('Submitted command');
  });

  it('reads explicit text/resource blocks and never duplicates encoded images as process output', () => {
    const view = render(call('exec_command', {}, { result: json({ content: [
      { type: 'text', text: 'First output' }, { type: 'image', data: 'BINARY_SENTINEL', mimeType: 'image/png' },
      { type: 'resource', resource: { text: 'Resource output' } }
    ] }) }));
    expect([...view.querySelectorAll('pre')].map(node => node.textContent)).toEqual(['First output', 'Resource output']);
    expect(view.textContent).not.toContain('BINARY_SENTINEL');
    expect(view.querySelector('img')).toBeNull();
    const truncated = render(call('exec_command', {}, { result: text('{"content":[{"type":"image","data":"BINARY_SENTINEL', { truncated: true }) }));
    expect(truncated.querySelector('pre')).toBeNull();
    expect(truncated.textContent).toContain('recorded result is truncated');
  });
});

describe('read, search and browser metadata', () => {
  it('presents each requested read path and its explicit range/byte limit', () => {
    const view = render(call('read', { paths: ['src/a.ts:10-20', 'src/b.ts'], start_line: 3, end_line: 8, max_bytes: 4096 }));
    expect(values(view, 'Requested path')).toEqual(['src/a.ts:10-20', 'src/b.ts']);
    expect(values(view, 'Requested first line')).toEqual(['3']);
    expect(values(view, 'Requested last line')).toEqual(['8']);
    expect(values(view, 'Requested byte limit')).toEqual(['4096']);
  });

  it('keeps explicit search flags including false and does not invent omitted search defaults', () => {
    const view = render(call('find', { query: '<literal>', path: '/project/src', mode: 'content',
      include: '**/*.ts', exclude: ['vendor'], case_sensitive: false, regex: true, max_results: 50 }));
    expect(values(view, 'Query')).toEqual(['<literal>']);
    expect(values(view, 'Case sensitive')).toEqual(['false']);
    expect(values(view, 'Regular expression')).toEqual(['true']);
    expect(values(view, 'Excluded folder')).toEqual(['vendor']);
    expect(values(view, 'Requested result limit')).toEqual(['50']);
    const omitted = render(call('find', { query: 'name' }));
    expect(values(omitted, 'Requested search path')).toEqual([]);
    expect(values(omitted, 'Requested search mode')).toEqual([]);
    expect(values(omitted, 'Case sensitive')).toEqual([]);
  });

  it('separates requested and observed browser identities while leaving URLs inert and access hints absent', () => {
    const view = render(call('browser_navigate', { action: 'url', tabId: 'browser:1', pageId: 'old-page', url: 'https://example.test/requested' }, {
      result: json({ structuredContent: { value: {
        title: '<script>not executable</script>', url: 'javascript:alert(1)', pageId: 'new-page',
        documentId: 'exact-document', accepted: true, attached: false, inspectionOnly: true,
        html: '<h1>BODY_SENTINEL</h1>', access: { input: 'PERMISSION_SENTINEL' }
      } } })
    }));
    expect(values(view, 'Requested page')).toEqual(['old-page']);
    expect(values(view, 'Recorded page')).toEqual(['new-page']);
    expect(values(view, 'Requested URL')).toEqual(['https://example.test/requested']);
    expect(values(view, 'Recorded URL')).toEqual(['javascript:alert(1)']);
    expect(values(view, 'Attachment recorded')).toEqual(['false']);
    expect(view.textContent).not.toMatch(/BODY_SENTINEL|PERMISSION_SENTINEL/);
    expect(view.querySelector('a, button, input, img, script, iframe, form, svg, object')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('supports plain recorded browser metadata and bounded counts without interpreting arbitrary evaluation output', () => {
    const view = render(call('browser_tabs', { action: 'list' }, { result: json({ tabs: [{ title: 'Tab A' }, { title: 'Tab B' }], truncated: true }) }));
    expect(values(view, 'Tabs in recorded response')).toEqual(['2']);
    expect(values(view, 'Result truncated')).toEqual(['true']);
    const evaluation = render(call('browser_evaluate', { expression: 'throw new Error("CODE_SENTINEL")', tabId: 'browser:1' }, {
      result: json({ structuredContent: { value: '<script>VALUE_SENTINEL</script>' } })
    }));
    expect(evaluation.textContent).not.toMatch(/CODE_SENTINEL|VALUE_SENTINEL/);
  });
});

describe('bounded optional presentation', () => {
  it('leaves unknown tools and lookalike names to the existing raw view', () => {
    for (const tool of ['external_apply_patch', 'exec', 'git_changes', 'browser_snapshot_extra'])
      expect(renderActionDetails(call(tool, { patch }))).toBeNull();
  });

  it('never mutates recorded arguments, result, changes or overflow metadata', () => {
    const value = call('apply_patch', { patch }, {
      result: text('Partial recorded result', { truncated: true, chars: 5000, assetId: 'original-overflow' }),
      changes: [{ path: 'exact-recorded-path', added: 2, removed: 1, approximate: true }]
    });
    const before = JSON.stringify(value);
    Object.freeze(value.args); Object.freeze(value.result); Object.freeze(value.changes); Object.freeze(value);
    const view = render(value);
    expect(JSON.stringify(value)).toBe(before);
    expect(view.textContent).toContain('recorded result is truncated');
  });

  it('bounds patch lines, long lines, aggregate text and per-call array expansion with visible notices', () => {
    const manyLines = '*** Begin Patch\n*** Add File: many.txt\n' + '+added\n'.repeat(5000) + '*** End Patch';
    const view = render(call('apply_patch', { patch: manyLines }));
    expect(view.querySelectorAll('.action-details-line').length).toBeLessThanOrEqual(ACTION_DETAILS_LIMITS.lines);
    expect(view.textContent).toContain('Action preview truncated');
    const longLine = render(call('exec_command', { cmd: 'x'.repeat(10_000) }, { result: json({ output: 'y'.repeat(100_000), exit_code: 0 }) }));
    expect(longLine.querySelector('.action-details-line')!.textContent!.length).toBeLessThanOrEqual(ACTION_DETAILS_LIMITS.lineChars);
    expect(longLine.textContent!.length).toBeLessThan(ACTION_DETAILS_LIMITS.textChars + 2000);
    expect(longLine.textContent).toContain('Action preview truncated');
    const array = render(call('read', { paths: Array.from({ length: 500 }, (_, index) => `file-${index}`) }));
    expect(values(array, 'Requested path')).toHaveLength(ACTION_DETAILS_LIMITS.items);
    expect(array.textContent).toContain('Action preview truncated');
  });

  it('refuses oversized JSON before interpreting it and rejects object-valued fields without coercion', () => {
    const value = call('read', {}, { args: json({ paths: ['DO_NOT_EXTRACT'], padding: 'x'.repeat(ACTION_DETAILS_LIMITS.jsonChars) }) });
    const view = render(value);
    expect(view.textContent).toContain('Structured details exceed the preview limit');
    expect(view.textContent).not.toContain('DO_NOT_EXTRACT');
    const malformed = render(call('find', { query: { text: 'UNSAFE_COERCION' }, path: ['not-a-scalar'], regex: false }));
    expect(values(malformed, 'Query')).toEqual([]);
    expect(values(malformed, 'Requested search path')).toEqual([]);
    expect(malformed.textContent).not.toContain('[object Object]');
  });

  it('uses scoped wrapping CSS without adding vertical scrolling or changing raw detail styles', () => {
    const baseline = document.createElement('style');
    baseline.textContent = '.pre { max-height: 260px; }';
    document.head.append(baseline);
    const style = document.createElement('style');
    style.textContent = readFileSync(new URL('../src/renderer/action-details.css', import.meta.url), 'utf8');
    document.head.append(style);
    const view = render(call('exec_command', { cmd: 'command' }));
    const computed = dom.window.getComputedStyle(view.querySelector('pre')!);
    expect(computed.maxHeight).toBe('none');
    expect(computed.overflow).toBe('visible');
    expect(computed.whiteSpace).toBe('pre-wrap');
    expect(computed.overflowWrap).toBe('anywhere');
    const raw = document.createElement('pre'); raw.className = 'pre'; document.body.append(raw);
    expect(dom.window.getComputedStyle(raw).maxHeight).toBe('260px');
  });
});
