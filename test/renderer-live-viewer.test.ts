import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createLiveViewerPanel } from '../src/renderer/live-viewer-panel.js';
import type { SessionEvent } from '../src/shared/session.js';

let dom: JSDOM;
afterEach(() => dom?.window.close());

function event(seq: number, args = '{"command":"hello"}', change = true): SessionEvent {
  return {
    kind: 'tool_call', seq, time: 1_780_000_000_000 + seq, source: 'mcp',
    call: {
      callId: 'call-' + seq, tool: 'exec_command', attribution: 'inferred',
      requestId: null, conversationId: null, attributionMethod: 'unattributed',
      args: { text: args, chars: args.length, truncated: false },
      result: { text: 'ok', chars: 2, truncated: false },
      outcome: 'ok', durationMs: 12,
      summary: { title: 'Ran safe command', kind: 'run', tone: 'good' },
      changes: change ? [{ path: 'src/example.ts', added: 3, removed: 1 }] : []
    }
  } as SessionEvent;
}
function setup(read: (id: string) => Promise<SessionEvent[] | null>) {
  dom = new JSDOM('<main></main>', { url: 'https://local.test/', pretendToBeVisual: true });
  Object.assign(globalThis, { document: dom.window.document, window: dom.window });
  const holder = document.querySelector('main')!;
  const selection = { id: 'chat-a' as string | null, generation: 1 };
  const panel = createLiveViewerPanel({ selection: () => selection, read });
  return { panel, holder, selection };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

it('renders recorded arguments, results and file changes without interpreting hostile markup', async () => {
  const hostile = '<img src=x onerror=alert(1)> & <script>throw 1</script>';
  const { panel, holder } = setup(async () => [event(1, hostile)]);
  panel.show(holder);
  await flush();
  expect(holder.querySelectorAll('.live-viewer-row')).toHaveLength(1);
  expect(holder.textContent).toContain(hostile);
  expect(holder.querySelector('img, script')).toBeNull();
  expect(holder.textContent).toContain('src/example.ts');
  const buttons = [...holder.querySelectorAll<HTMLButtonElement>('[data-filter]')];
  buttons.find(button => button.dataset.filter === 'changes')!.click();
  expect(holder.querySelectorAll('.live-viewer-row')).toHaveLength(1);
  buttons.find(button => button.dataset.filter === 'all')!.click();
  expect(holder.querySelectorAll('.live-viewer-row')).toHaveLength(1);
  expect(holder.textContent).toContain('Not token-by-token');
});

it('does not paint stale async response after chat A → B → A', async () => {
  const resolvers: Array<(rows: SessionEvent[]) => void> = [];
  const read = vi.fn(() => new Promise<SessionEvent[]>(resolve => resolvers.push(resolve)));
  const { panel, holder, selection } = setup(read);
  panel.show(holder);
  selection.id = 'chat-b'; selection.generation++;
  panel.selected(selection.id, selection.generation);
  selection.id = 'chat-a'; selection.generation++;
  panel.selected(selection.id, selection.generation);
  resolvers[0]!([event(1, 'stale from old A')]);
  await flush();
  expect(holder.textContent).not.toContain('stale from old A');
  resolvers[2]!([event(3, 'current A')]);
  await flush();
  expect(holder.textContent).toContain('current A');
  resolvers[1]!([event(2, 'stale B')]);
  await flush();
  expect(holder.textContent).not.toContain('stale B');
});

it('merges revisions without duplicating one chronological position and ignores inactive owners', async () => {
  const { panel, holder, selection } = setup(async () => []);
  panel.show(holder);
  await flush();
  const base = event(4);
  const revision = { ...base, seq: 7, origin: 4, call: { ...('call' in base ? base.call : {}), result: { text: 'revised', chars: 7, truncated: false } } } as SessionEvent;
  panel.sync(selection.id!, selection.generation, [base]);
  panel.sync(selection.id!, selection.generation, [revision]);
  panel.sync('chat-b', selection.generation, [event(9, 'foreign')]);
  expect(holder.querySelectorAll('.live-viewer-row')).toHaveLength(1);
  expect(holder.textContent).toContain('revised');
  expect(holder.textContent).not.toContain('foreign');
});

it('retires pending reads when the dock hides and continues on reopen', async () => {
  let resolve!: (events: SessionEvent[]) => void;
  const { panel, holder } = setup(() => new Promise(done => { resolve = done; }));
  panel.show(holder);
  panel.hide();
  resolve([event(1, 'hidden response')]);
  await flush();
  expect(holder.querySelector('.live-viewer-panel')?.hasAttribute('hidden')).toBe(true);
  expect(holder.textContent).not.toContain('hidden response');
});
