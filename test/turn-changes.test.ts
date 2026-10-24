import { expect, it } from 'vitest';
import { netTurnChanges, netTurnFileDiff, turnFileEdits } from '../src/main/session/turn-changes.js';
import type { SessionEvent, ToolCallRecord } from '../src/shared/session.js';

/**
 * #1827: what one answer changed, per file. A file edited three times is one row with one net
 * diff: before the turn's first edit against after its last one.
 */
let seq = 0;
const call = (turnId: string, changes: Array<{ path: string; added?: number; removed?: number; kept?: boolean; approximate?: boolean }>,
  kind: 'edit' | 'create' | 'delete' = 'edit', agent?: string): SessionEvent => ({
  seq: ++seq, time: seq, source: 'mcp', kind: 'tool_call', turnId, ...(agent ? { agent } : {}),
  call: { callId: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, tool: 'apply_patch', outcome: 'ok',
    summary: { title: 'Edited', tone: 'good', kind }, changes: changes.map(change => ({ path: change.path, added: change.added ?? 1, removed: change.removed ?? 0,
      approximate: change.approximate ?? false, ...(change.kept === false ? { reviewUnavailable: 'not-kept' as const } : { reviewAssetId: `asset-${seq}` }) })) } as unknown as ToolCallRecord
} as SessionEvent);

it('lists each file once, in the order it was first changed, from this turn only and not a worker\'s', () => {
  seq = 0;
  const events = [
    call('t1', [{ path: 'src/b.ts' }]),
    call('t2', [{ path: 'src/a.ts', added: 3 }, { path: 'src/new.ts', added: 12 }], 'edit'),
    call('t2', [{ path: 'src/a.ts', added: 2, removed: 1 }]),
    call('t2', [{ path: 'src/worker.ts' }], 'edit', 'worker-1'),
    call('t2', [{ path: 'old/helper.ts', added: 0, removed: 2 }], 'delete')
  ];
  const edits = turnFileEdits(events, 't2');
  expect(edits.map(edit => edit.path)).toEqual(['src/a.ts', 'src/new.ts', 'old/helper.ts']);
  expect(edits[0]).toMatchObject({ edits: 2, recordedAdded: 5, recordedRemoved: 1, first: { callId: expect.any(String), index: 0 }, last: { index: 0 } });
  expect(edits[0]!.first.callId).not.toBe(edits[0]!.last.callId);
  expect(edits[2]).toMatchObject({ deleted: true });
});

it('measures one net diff per file from the first edit\'s before to the last edit\'s after', async () => {
  seq = 0;
  const events = [call('t', [{ path: 'a.ts' }]), call('t', [{ path: 'a.ts' }]), call('t', [{ path: 'back.ts' }]), call('t', [{ path: 'back.ts' }])];
  const texts: Record<string, { before: string; after: string }> = {
    [events[0]!.kind === 'tool_call' ? events[0]!.call.callId : '']: { before: 'one\ntwo\n', after: 'one\nTWO\n' },
    [events[1]!.kind === 'tool_call' ? events[1]!.call.callId : '']: { before: 'one\nTWO\n', after: 'one\nTWO\nthree\n' },
    [events[2]!.kind === 'tool_call' ? events[2]!.call.callId : '']: { before: 'x\n', after: 'y\n' },
    [events[3]!.kind === 'tool_call' ? events[3]!.call.callId : '']: { before: 'y\n', after: 'x\n' }
  };
  const changes = await netTurnChanges(turnFileEdits(events, 't'), async ({ callId }) => texts[callId] ?? null);
  expect(changes).toEqual([
    expect.objectContaining({ path: 'a.ts', state: 'edited', added: 2, removed: 1, approximate: false, diff: 'kept' }),
    expect.objectContaining({ path: 'back.ts', state: 'unchanged', added: 0, removed: 0, diff: 'kept' })
  ]);
});

it('says created and deleted, and falls back to the recorded counts, marked approximate, when an end was not kept', async () => {
  seq = 0;
  const events = [
    call('t', [{ path: 'new.ts', added: 12 }], 'create'),
    call('t', [{ path: 'gone.ts', added: 0, removed: 4 }], 'delete'),
    call('t', [{ path: 'big.ts', added: 900, removed: 10, kept: false }]),
    call('t', [{ path: 'brief.ts', added: 1, removed: 0 }], 'create'),
    call('t', [{ path: 'brief.ts', added: 0, removed: 1 }], 'delete')
  ];
  const id = (index: number) => (events[index] as Extract<SessionEvent, { kind: 'tool_call' }>).call.callId;
  const texts: Record<string, { before: string; after: string }> = {
    [id(0)]: { before: '', after: 'a\n'.repeat(12) }, [id(1)]: { before: 'x\n'.repeat(4), after: '' },
    [id(3)]: { before: '', after: 'tmp\n' }, [id(4)]: { before: 'tmp\n', after: '' }
  };
  const changes = await netTurnChanges(turnFileEdits(events, 't'), async ({ callId }) => texts[callId] ?? null);
  expect(changes.map(change => [change.path, change.state, change.added, change.removed, change.approximate, change.diff])).toEqual([
    ['new.ts', 'created', 12, 0, false, 'kept'],
    ['gone.ts', 'deleted', 0, 4, false, 'kept'],
    ['big.ts', 'edited', 900, 10, true, 'not-kept'],
    // Made and removed in the same answer: listed, so the list matches what the answer did.
    ['brief.ts', 'unchanged', 0, 0, false, 'kept']
  ]);
});

it('shows the first fifty files and says how many more', async () => {
  seq = 0;
  const events = Array.from({ length: 62 }, (_, index) => call('t', [{ path: `f${index}.ts` }]));
  const edits = turnFileEdits(events, 't');
  expect(edits).toHaveLength(62);
  const changes = await netTurnChanges(edits, async () => ({ before: 'a\n', after: 'b\n' }), 50);
  expect(changes).toHaveLength(50);
});

it('reads the net diff from the stored edit records', async () => {
  const { makeTempDir, removeTempDir } = await import('./helpers.js');
  const dir = await makeTempDir('cos-turn-changes-');
  const store = await import('../src/main/session/store.js');
  store.initSessionStore(dir);
  try {
    const session = await store.createSession({ title: 'Changes' });
    const asset = async (before: string, after: string) => (await store.writeAsset(session.id, Buffer.from(JSON.stringify({ before, after })), 'text/plain')).id;
    const edit = async (turnId: string, path: string, before: string, after: string) => store.appendEvent(session.id, {
      time: Date.now(), source: 'mcp', kind: 'tool_call', turnId,
      call: { callId: crypto.randomUUID(), tool: 'apply_patch', outcome: 'ok', summary: { title: 'Edited', tone: 'good', kind: 'edit' }, durationMs: 1, attribution: 'request_id',
        args: { text: '', truncated: false, chars: 0 }, result: { text: '', truncated: false, chars: 0 },
        changes: [{ path, added: 1, removed: 1, approximate: false, reviewAssetId: await asset(before, after) }] } as never
    } as never);
    const start = await store.appendEvent(session.id, { time: Date.now(), source: 'extension', kind: 'turn_start', turnId: 'answer' });
    await edit('answer', 'src/a.ts', 'one\ntwo\n', 'one\nTWO\n');
    await edit('answer', 'src/a.ts', 'one\nTWO\n', 'one\nTWO\nthree\n');
    const files = turnFileEdits(await store.readEvents(session.id, { from: start.seq, kinds: ['tool_call'] }), 'answer');
    const review = (at: { assetId?: string }) => at.assetId ? store.readEditReviewAsset(session.id, at.assetId) : Promise.resolve(null);
    expect(await netTurnChanges(files, review)).toEqual([expect.objectContaining({ path: 'src/a.ts', state: 'edited', added: 2, removed: 1, edits: 2, diff: 'kept' })]);
    expect(await netTurnFileDiff(files, 'src/a.ts', review)).toEqual({ before: 'one\ntwo\n', after: 'one\nTWO\nthree\n' });
    expect(await netTurnFileDiff(files, 'other.ts', review)).toBeNull();
  } finally { store.resetSessionStoreForTests(); await removeTempDir(dir); }
});
