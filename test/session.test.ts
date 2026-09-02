/**
 * The session recorder, its store, and everything that reads back out of it.
 *
 * Real files in a real temp folder, because the properties that matter here are
 * durability properties: a torn line must cost one event and not a session, a
 * reopened conversation must continue its own log, and a handoff must survive the
 * pruner. None of that is observable against an in-memory fake.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, initConfigPath, saveConfig } from '../src/main/config.js';
import { lineDelta, formatDelta } from '../src/main/diffstat.js';
import { chunkText } from '../src/main/mcp/tools.js';
import { emptyEvidence } from '../src/main/mcp/call-context.js';
import { getLog } from '../src/main/logger.js';
import {
  closeConversation,
  liveConversations,
  noteChatOrigin,
  recordChatObservations,
  recordToolCall,
  repairDeterministicAttribution,
  rebindConversation,
  resetRecorderForTests,
  sessionForConversation,
} from '../src/main/session/recorder.js';
import {
  appendEvent,
  autoCompactionReady,
  createSession,
  deleteSession,
  endSession,
  flushSessions,
  findSessionByConversation,
  getSession,
  initSessionStore,
  latestHandoff,
  listSessions,
  MAX_ASSET_BYTES,
  pruneSessions,
  readAsset,
  readEvents,
  readRecentEvents,
  readHandoff,
  rebindSession,
  renameSession,
  reopenSession,
  resetSessionStoreForTests,
  rewriteUnattributedToolCalls,
  saveHandoff,
  sessionsRoot,
  unsetSessionRootForTests,
  upsertMessageEvent,
  writeAsset
} from '../src/main/session/store.js';
import { summarizeToolCall } from '../src/main/session/summarize.js';
import { HANDOFF_BRIEF_RULES, nativeHandoffPrompt } from '../src/main/session/handoff-prompt.js';
import {
  CHAT_ACTIVE_MS,
  CHAT_SILENCE_MS,
  estimateTokens,
  eventTokens,
  foldProgress,
  originTitle,
  tokenPressure,
  type SessionEvent,
  type SessionOrigin,
  type ToolOutcome
} from '../src/shared/session.js';
import { makeTempDir, removeTempDir } from './helpers.js';

let dir: string;

async function enableRecording(record = true): Promise<void> {
  await saveConfig({ ...defaultConfig(), sessions: { ...defaultConfig().sessions, record } });
}

beforeAll(async () => {
  dir = await makeTempDir('clf-session-');
  initConfigPath(dir);
  initSessionStore(dir);
  await enableRecording();
});

afterAll(async () => {
  resetSessionStoreForTests();
  await removeTempDir(dir);
});

beforeEach(() => {
  resetRecorderForTests();
  resetSessionStoreForTests();
});

const evidence = (patch: Partial<ReturnType<typeof emptyEvidence>> = {}) => ({ ...emptyEvidence(), ...patch });
// ------------------------------------------------------------------- store

describe('session store', () => {
  it('preserves tool calls appended after an unattributed repair snapshot', async () => {
    const summary = await createSession({ title: 'Unattributed activity', conversationId: null });
    const call = (callId: string, time: number) => ({
      time,
      source: 'mcp' as const,
      kind: 'tool_call' as const,
      call: {
        callId,
        tool: 'read',
        attribution: 'unattributed' as const,
        requestId: null,
        conversationId: null,
        attributionMethod: 'unattributed' as const,
        args: { text: '{}', truncated: false, chars: 2 },
        result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok' as const,
        durationMs: 1,
        summary: { title: callId, tone: 'neutral' as const, kind: 'read' as const }
      }
    });

    await appendEvent(summary.id, call('keep-old-unknown', 1));
    await appendEvent(summary.id, call('remove-old-repaired', 2));
    const snapshot = await readEvents(summary.id);
    const scannedThroughSeq = Math.max(...snapshot.map((event) => event.seq));
    const keptFromSnapshot = snapshot.filter(
      (event): event is Extract<SessionEvent, { kind: 'tool_call' }> =>
        event.kind === 'tool_call' && event.call.callId === 'keep-old-unknown'
    );

    // This append lands after the repair decided its old keep/remove set, but before the rewrite
    // is enqueued. It used to be silently discarded when the old snapshot replaced events.jsonl.
    await appendEvent(summary.id, call('keep-concurrent-new', 3));
    await rewriteUnattributedToolCalls(summary.id, keptFromSnapshot, scannedThroughSeq);

    const callIds = (await readEvents(summary.id))
      .filter((event): event is Extract<SessionEvent, { kind: 'tool_call' }> => event.kind === 'tool_call')
      .map((event) => event.call.callId);
    expect(callIds).toEqual(['keep-old-unknown', 'keep-concurrent-new']);

    // The rewrite re-sequences its retained snapshot. A subsequent append must continue after it
    // rather than reusing the concurrent row's sequence number.
    await appendEvent(summary.id, call('keep-after-rewrite', 4));
    const after = (await readEvents(summary.id)).filter((event) => event.kind === 'tool_call');
    expect(after.map((event) => event.call.callId)).toEqual([
      'keep-old-unknown',
      'keep-concurrent-new',
      'keep-after-rewrite'
    ]);
    expect(new Set(after.map((event) => event.seq)).size).toBe(3);
  });

  it('synchronizes reads only with their target session instead of flushing every open session', async () => {
    const first = await createSession({ title: 'read target' });
    const other = await createSession({ title: 'unrelated writer' });
    await appendEvent(first.id, { time: 1000, source: 'app', kind: 'note', message: { text: 'a', truncated: false, chars: 1 } });
    await appendEvent(other.id, { time: 1001, source: 'app', kind: 'note', message: { text: 'b', truncated: false, chars: 1 } });

    await readEvents(first.id);
    const otherMetaAfterFullRead = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), other.id, 'meta.json'), 'utf8')
    ) as { events: number };
    expect(otherMetaAfterFullRead.events).toBe(0);

    await flushSessions();
    const otherMetaAfterExplicitFlush = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), other.id, 'meta.json'), 'utf8')
    ) as { events: number };
    expect(otherMetaAfterExplicitFlush.events).toBe(1);

    await appendEvent(first.id, { time: 1002, source: 'app', kind: 'note', message: { text: 'c', truncated: false, chars: 1 } });
    await appendEvent(other.id, { time: 1003, source: 'app', kind: 'note', message: { text: 'd', truncated: false, chars: 1 } });
    await readRecentEvents(first.id, 10);
    const otherMetaAfterRecentRead = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), other.id, 'meta.json'), 'utf8')
    ) as { events: number };
    expect(otherMetaAfterRecentRead.events).toBe(1);
  });

  it('counts stable legacy message revisions once when building a recent presentation window', async () => {
    const summary = await createSession({ title: 'legacy recent dedupe' });
    await appendEvent(summary.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      messageId: 'legacy-user-1',
      message: { text: 'original user request', truncated: false, chars: 21 }
    } as never);
    // Pre-canonical recordings could append every streaming snapshot of one stable ChatGPT
    // message to events.jsonl. The recent reader used those revisions as separate rows, so a
    // long answer could fill Goal Mode's entire recent window with copies of itself and hide
    // the user turn it was answering. Newest-first scanning should keep the latest revision
    // for a stable message id, but keep walking until it has the requested number of logical
    // messages.
    for (let index = 0; index < 8; index++) {
      await appendEvent(summary.id, {
        time: 1_001 + index,
        source: 'extension',
        kind: 'assistant_message',
        messageId: 'legacy-assistant-1',
        message: { text: `answer revision ${index}`, truncated: false, chars: 17 },
        final: index === 7
      } as never);
    }

    const recent = await readRecentEvents(summary.id, 2, {
      kinds: ['user_message', 'assistant_message']
    });
    expect(recent).toHaveLength(2);
    expect(recent.map((event) => event.kind)).toEqual(['user_message', 'assistant_message']);
    expect(recent[1]?.kind === 'assistant_message' ? recent[1].message.text : '').toBe('answer revision 7');
  });

  it('negative-caches unknown current conversation lookups until that exact attachment can be created', async () => {
    const conversationId = `conv-missing-${Date.now()}`;
    const readdir = vi.spyOn(fs, 'readdir');
    const rootPath = sessionsRoot();
    const rootReads = (): number => readdir.mock.calls.filter(([target]) => String(target) === rootPath).length;

    // Restored in `finally`, like every other readdir spy in this file. Restoring on the
    // success path alone turns one failure here into a file-wide cascade: the spy survives
    // the failing test, the next test binds `realReaddir` to that leaked spy and installs its
    // own delegating to it, and the pair recurses until "Maximum call stack size exceeded" —
    // which is what the failure then reads as, in a different test, with the real one buried.
    try {
      expect(await findSessionByConversation(conversationId)).toBeNull();
      expect(rootReads()).toBe(1);
      expect(await findSessionByConversation(conversationId)).toBeNull();
      expect(rootReads()).toBe(1);

      const created = await createSession({ conversationId, title: 'now attached' });
      expect((await findSessionByConversation(conversationId))?.id).toBe(created.id);
      // The durable create updates the derived attachment catalog directly. No second global
      // metadata scan is needed merely to discover the session this process just committed.
      expect(rootReads()).toBe(1);
    } finally {
      readdir.mockRestore();
    }
  });

  it('invalidates a cached miss before an in-flight session creation can be hidden by it', async () => {
    const conversationId = `conv-creating-${Date.now()}`;
    expect(await findSessionByConversation(conversationId)).toBeNull();

    const realWriteFile = fs.writeFile.bind(fs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const creationVisible = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let paused = false;
    const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(
      (async (target: Parameters<typeof fs.writeFile>[0], ...args: unknown[]) => {
        if (!paused && String(target).endsWith('messages.json')) {
          paused = true;
          reached();
          await gate;
        }
        return (realWriteFile as (...callArgs: unknown[]) => ReturnType<typeof fs.writeFile>)(target, ...args);
      }) as typeof fs.writeFile
    );

    try {
      const creating = createSession({ conversationId, title: 'in flight' });
      await creationVisible;
      const visible = await findSessionByConversation(conversationId);
      expect(visible?.conversationId).toBe(conversationId);
      release();
      expect((await creating).id).toBe(visible?.id);
    } finally {
      release();
      writeSpy.mockRestore();
    }
  });

  it('finds an attachment beyond the 5,000-session maintenance scan cap', async () => {
    const seed = await createSession({ title: 'catalog seed', conversationId: null });
    const seedSummary = await getSession(seed.id);
    expect(seedSummary).not.toBeNull();
    // Force the next lookup to rebuild from the durable catalog rather than the live seed.
    resetSessionStoreForTests();

    const conversationId = `conv-deep-catalog-${Date.now()}`;
    const names = Array.from({ length: 5001 }, (_, index) => `catalog-${String(index).padStart(5, '0')}`);
    const targetId = names[names.length - 1] as string;
    const realReaddir = fs.readdir.bind(fs);
    const realReadFile = fs.readFile.bind(fs);
    const rootPath = sessionsRoot();
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(
      (async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        if (String(target) === rootPath) return names;
        return (realReaddir as (...callArgs: unknown[]) => ReturnType<typeof fs.readdir>)(target, ...args);
      }) as typeof fs.readdir
    );
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(
      (async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        const file = String(target);
        const id = path.basename(path.dirname(file));
        if (file.endsWith('meta.json') && id.startsWith('catalog-')) {
          return JSON.stringify({
            ...seedSummary,
            id,
            title: id,
            conversationId: id === targetId ? conversationId : null,
            chatIds: id === targetId ? [conversationId] : []
          });
        }
        return (realReadFile as (...callArgs: unknown[]) => ReturnType<typeof fs.readFile>)(target, ...args);
      }) as typeof fs.readFile
    );

    try {
      expect((await findSessionByConversation(conversationId, { requireUnique: true }))?.id).toBe(targetId);
    } finally {
      readSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  }, 90_000);

  it('does not cache a transient root scan failure as an authoritative empty attachment catalog', async () => {
    const conversationId = `conv-transient-catalog-${Date.now()}`;
    const created = await createSession({ conversationId, title: 'durable attachment' });
    await flushSessions();
    resetSessionStoreForTests();

    const rootPath = sessionsRoot();
    const realReaddir = fs.readdir.bind(fs);
    let failedOnce = false;
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(
      (async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        if (!failedOnce && String(target) === rootPath) {
          failedOnce = true;
          throw Object.assign(new Error('transient session-root read failure'), { code: 'EBUSY' });
        }
        return (realReaddir as (...callArgs: unknown[]) => ReturnType<typeof fs.readdir>)(target, ...args);
      }) as typeof fs.readdir
    );

    try {
      await expect(findSessionByConversation(conversationId, { requireUnique: true })).rejects.toMatchObject({
        code: 'EBUSY'
      });
      expect((await findSessionByConversation(conversationId, { requireUnique: true }))?.id).toBe(created.id);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it('numbers events in append order and reads them back unchanged', async () => {
    const summary = await createSession({ title: 'ordering', conversationId: null });
    const kinds: SessionEvent['kind'][] = ['user_message', 'turn_start', 'progress', 'turn_end'];
    await appendEvent(summary.id, {
      time: 1000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'do the thing', truncated: false, chars: 12 }
    });
    await appendEvent(summary.id, { time: 1001, source: 'extension', kind: 'turn_start' });
    await appendEvent(summary.id, {
      time: 1002,
      source: 'extension',
      kind: 'progress',
      message: { text: 'reading files', truncated: false, chars: 13 }
    });
    await appendEvent(summary.id, { time: 1003, source: 'extension', kind: 'turn_end', outcome: 'completed' });

    const events = await readEvents(summary.id);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(events.map((event) => event.kind)).toEqual(kinds);
  });

  it('reorders late events only inside the durable turn that owns them', async () => {
    const summary = await createSession({ title: 'deferred append' });
    await appendEvent(summary.id, { time: 1000, source: 'extension', kind: 'turn_start', turnId: 'g-order' });
    await appendEvent(summary.id, {
      time: 5000,
      source: 'extension',
      kind: 'progress',
      turnId: 'g-order',
      message: { text: 'later progress', truncated: false, chars: 14 }
    });
    // Arrived late, but logically happened between the two rows above.
    await appendEvent(summary.id, {
      time: 2000,
      source: 'extension',
      kind: 'progress',
      turnId: 'g-order',
      message: { text: 'earlier progress', truncated: false, chars: 16 }
    });
    await appendEvent(summary.id, { time: 6000, source: 'extension', kind: 'turn_end', turnId: 'g-order', outcome: 'completed' });
    const events = await readEvents(summary.id);
    expect(events.map((event) => event.kind)).toEqual(['turn_start', 'progress', 'progress', 'turn_end']);
    expect(events.slice(1, 3).map((event) => event.time)).toEqual([2000, 5000]);
    // The JSONL stays append-only: the logically earlier progress still has the later seq.
    expect(events[1]!.seq).toBeGreaterThan(events[2]!.seq);
  });

  it('keeps a session from ageing backwards when a call is written late', async () => {
    const summary = await createSession({ title: 'late append' });
    const now = Date.now();
    await appendEvent(summary.id, { time: now, source: 'extension', kind: 'turn_end', outcome: 'completed' });
    await appendEvent(summary.id, { time: now - 5000, source: 'mcp', kind: 'turn_start' });
    expect((await getSession(summary.id))?.updatedAt).toBe(now);
  });

  it('filters by kind and by starting sequence number', async () => {
    const summary = await createSession({ title: 'filters' });
    for (let i = 0; i < 6; i++) {
      await appendEvent(summary.id, {
        time: 1000 + i,
        source: 'extension',
        kind: i % 2 === 0 ? 'progress' : 'turn_start',
        ...(i % 2 === 0 ? { message: { text: `step ${i}`, truncated: false, chars: 6 } } : {})
      } as never);
    }
    const progress = await readEvents(summary.id, { kinds: ['progress'] });
    expect(progress).toHaveLength(3);
    const tail = await readEvents(summary.id, { from: 4 });
    expect(tail.every((event) => event.seq >= 4)).toBe(true);
    expect(await readEvents(summary.id, { limit: 2 })).toHaveLength(2);
  });

  it('never downgrades a final canonical message when a stale streaming snapshot arrives later', async () => {
    const summary = await createSession({ title: 'terminal canonical final' });
    const messageId = 'msg-terminal-final';
    const final = await upsertMessageEvent(summary.id, {
      time: 100,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message: { text: 'Complete answer.', truncated: false, chars: 16 },
      renderedHtml: { text: '<p><strong>Complete</strong> answer.</p>', truncated: false, chars: 40 },
      state: 'final',
      final: true
    });
    const stale = await upsertMessageEvent(summary.id, {
      time: 120,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message: { text: 'Complete', truncated: false, chars: 8 },
      renderedHtml: { text: '<p>Complete</p>', truncated: false, chars: 15 },
      state: 'streaming',
      final: false
    });

    expect(stale.changed).toBe(false);
    expect(stale.event.seq).toBe(final.event.seq);
    const [stored] = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(stored?.kind === 'assistant_message' && stored.final).toBe(true);
    expect(stored?.kind === 'assistant_message' && stored.message.text).toBe('Complete answer.');
  });

  it('keeps rich HTML when the same canonical prose is reobserved without rendered HTML', async () => {
    const summary = await createSession({ title: 'sparse rich final' });
    const messageId = 'msg-sparse-rich';
    const message = { text: 'Bold answer', truncated: false, chars: 11 };
    await upsertMessageEvent(summary.id, {
      time: 200,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message,
      renderedHtml: { text: '<p><strong>Bold</strong> answer</p>', truncated: false, chars: 35 },
      state: 'final',
      final: true
    });
    const repeated = await upsertMessageEvent(summary.id, {
      time: 220,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message,
      state: 'final',
      final: true
    });

    expect(repeated.changed).toBe(false);
    expect(repeated.event.kind === 'assistant_message' && repeated.event.renderedHtml?.text).toBe(
      '<p><strong>Bold</strong> answer</p>'
    );
    expect(await readEvents(summary.id, { kinds: ['assistant_message'] })).toHaveLength(1);
  });

  it('lets an authoritative page-model timestamp correct a delayed DOM first sight', async () => {
    const summary = await createSession({ title: 'authored timestamp correction' });
    const messageId = 'user-authored-time';
    const message = { text: 'the real question', truncated: false, chars: 17 };
    const first = await upsertMessageEvent(summary.id, {
      time: 20_000,
      source: 'extension',
      kind: 'user_message',
      messageId,
      message
    });
    const corrected = await upsertMessageEvent(
      summary.id,
      {
        time: 10_000,
        source: 'extension',
        kind: 'user_message',
        messageId,
        message
      },
      { preferTime: true }
    );

    expect(corrected.changed).toBe(true);
    expect(corrected.event.time).toBe(10_000);
    expect(corrected.event.kind === 'user_message' && corrected.event.origin).toBe(first.event.seq);
    const [stored] = await readEvents(summary.id, { kinds: ['user_message'] });
    expect(stored?.time).toBe(10_000);
    expect(stored?.kind === 'user_message' && stored.origin).toBe(first.event.seq);
  });

  it('revises one canonical row only when the website logical identity is the same', async () => {
    const summary = await createSession({ title: 'stable website identity' });
    const turnId = 'g-stream-growth';
    const logicalId = 'thought-website-parent';
    const snapshots = [
      'Eight calls in, still zero writes.',
      'Eight calls in, still zero writes. The repo was already very',
      'Eight calls in, still zero writes. The repo was already very dirty before this check.'
    ];

    for (let index = 0; index < snapshots.length; index++) {
      const text = snapshots[index]!;
      await upsertMessageEvent(summary.id, {
        time: 100 + index,
        source: 'extension',
        kind: 'assistant_message',
        turnId,
        messageId: logicalId,
        message: { text, truncated: false, chars: text.length },
        state: index === snapshots.length - 1 ? 'final' : 'streaming',
        final: index === snapshots.length - 1
      });
    }

    const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.kind === 'assistant_message' && messages[0].messageId).toBe(logicalId);
    expect(messages[0]?.kind === 'assistant_message' && messages[0].message.text).toBe(snapshots.at(-1));
    expect(messages[0]?.kind === 'assistant_message' && messages[0].state).toBe('final');
  });

  it('keeps the first sequence as the origin of a revised stable user message', async () => {
    const summary = await createSession({ title: 'stable user boundary' });
    const message = { text: 'the user turn boundary', truncated: false, chars: 22 };
    const first = await upsertMessageEvent(summary.id, {
      time: 100,
      source: 'extension',
      kind: 'user_message',
      turnId: 'page-user-before',
      messageId: 'user-stable-boundary',
      message
    });
    const revised = await upsertMessageEvent(summary.id, {
      time: 200,
      source: 'extension',
      kind: 'user_message',
      turnId: 'page-user-after',
      messageId: 'user-stable-boundary',
      message
    });

    expect(revised.changed).toBe(true);
    expect(first.event.kind === 'user_message' && first.event.origin).toBe(first.event.seq);
    expect(revised.event.kind === 'user_message' && revised.event.origin).toBe(first.event.seq);
    expect(revised.event.seq).toBeGreaterThan(first.event.seq);
    const stored = await readEvents(summary.id, { kinds: ['user_message'] });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.kind === 'user_message' && stored[0].origin).toBe(first.event.seq);
  });

  it('never merges distinct website identities merely because their prose is a prefix continuation', async () => {
    const summary = await createSession({ title: 'distinct website identities' });
    const turnId = 'g-distinct-prefix';
    const first = 'First checkpoint.';
    const second = 'First checkpoint. Second checkpoint.';

    for (const [messageId, text] of [
      ['thought-parent-a', first],
      ['thought-parent-b', second]
    ] as const) {
      await upsertMessageEvent(summary.id, {
        time: Date.now(),
        source: 'extension',
        kind: 'assistant_message',
        turnId,
        messageId,
        message: { text, truncated: false, chars: text.length },
        state: 'streaming',
        final: false
      });
    }

    const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(2);
    expect(messages.map((event) => event.kind === 'assistant_message' && event.messageId)).toEqual([
      'thought-parent-a',
      'thought-parent-b'
    ]);
  });

  it('does not merge separate streaming commentary that merely shares a turn', async () => {
    const summary = await createSession({ title: 'separate streaming commentary' });
    const turnId = 'g-separate-commentary';
    for (const [messageId, text] of [
      ['comment-a', 'First three are clean; continuing the checks.'],
      ['comment-b', 'Eight calls in; still zero writes.']
    ] as const) {
      await upsertMessageEvent(summary.id, {
        time: Date.now(),
        source: 'extension',
        kind: 'assistant_message',
        turnId,
        messageId,
        message: { text, truncated: false, chars: text.length },
        state: 'streaming',
        final: false
      });
    }

    const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(2);
    expect(messages.map((event) => event.kind === 'assistant_message' && event.message.text)).toEqual([
      'First three are clean; continuing the checks.',
      'Eight calls in; still zero writes.'
    ]);
  });

  it('keeps a settled raw website id distinct from a different provisional id', async () => {
    const summary = await createSession({ title: 'different id at final' });
    const turnId = 'g-stream-final-remount';
    const text = 'The completed answer is already fully visible.';
    await upsertMessageEvent(summary.id, {
      time: 100,
      source: 'extension',
      kind: 'assistant_message',
      turnId,
      messageId: 'raw-streaming',
      message: { text, truncated: false, chars: text.length },
      state: 'streaming',
      final: false
    });
    await upsertMessageEvent(summary.id, {
      time: 110,
      source: 'extension',
      kind: 'assistant_message',
      turnId,
      messageId: 'raw-final-remount',
      message: { text, truncated: false, chars: text.length },
      state: 'final',
      final: true
    });

    const messages = await readEvents(summary.id, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(2);
    expect(messages.map((event) => event.kind === 'assistant_message' && event.messageId)).toEqual([
      'raw-streaming',
      'raw-final-remount'
    ]);
    expect(messages[1]?.kind === 'assistant_message' && messages[1].state).toBe('final');
  });

  it('keeps running counters and a token estimate on the summary', async () => {
    const summary = await createSession({ title: 'counters' });
    await appendEvent(summary.id, {
      time: 1,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'x'.repeat(400), truncated: false, chars: 400 }
    });
    await appendEvent(summary.id, {
      time: 2,
      source: 'extension',
      kind: 'chat_error',
      message: { text: 'something broke', truncated: false, chars: 15 }
    });
    await appendEvent(summary.id, { time: 3, source: 'extension', kind: 'turn_end', outcome: 'interrupted' });

    const after = await getSession(summary.id);
    expect(after?.userMessages).toBe(1);
    expect(after?.errors).toBe(1);
    expect(after?.lastTurnOutcome).toBe('interrupted');
    expect(after?.estimatedTokens).toBeGreaterThanOrEqual(100);
  });

  it('keeps the exact last attributed tool-call time separate from unrelated session activity', async () => {
    const summary = await createSession({ title: 'tool activity clock' });
    const toolAt = summary.startedAt + 20;
    const laterAt = summary.startedAt + 90;
    await appendEvent(summary.id, {
      time: toolAt,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'call-tool-clock',
        tool: 'read',
        attribution: 'request_id',
        requestId: 'wfr-tool-clock',
        conversationId: 'c-tool-clock',
        attributionMethod: 'request_id',
        args: { text: '{"paths":["/project/a.ts"]}', truncated: false, chars: 27 },
        result: { text: 'ok', truncated: false, chars: 2 },
        outcome: 'ok',
        durationMs: 1,
        summary: { title: 'Read a.ts', tone: 'neutral', kind: 'read' }
      }
    });
    await appendEvent(summary.id, {
      time: laterAt,
      source: 'extension',
      kind: 'note',
      message: { text: 'later but not a tool call', truncated: false, chars: 25 }
    });

    expect(await getSession(summary.id)).toMatchObject({ updatedAt: laterAt, lastToolCallAt: toolAt });
  });

  it('projects a stable final assistant message as the exact end of recent tool activity', async () => {
    const summary = await createSession({ title: 'final activity boundary' });
    const messageId = 'assistant-final-activity-boundary';
    await upsertMessageEvent(summary.id, {
      time: 100,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message: { text: 'Still working', truncated: false, chars: 13 },
      state: 'streaming',
      final: false
    });
    expect((await getSession(summary.id))?.lastAssistantFinalAt).toBeNull();

    await upsertMessageEvent(summary.id, {
      time: 200,
      source: 'extension',
      kind: 'assistant_message',
      messageId,
      message: { text: 'Finished.', truncated: false, chars: 9 },
      state: 'final',
      final: true
    });

    expect((await getSession(summary.id))?.lastAssistantFinalAt).toBe(200);
  });

  it('keeps the open turn open when the ChatGPT page detaches mid-turn', async () => {
    const conversationId = 'c-detach-keeps-turn-open';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: 10, text: 'run the long job', messageId: 'detach-user-1' },
      { kind: 'turn_start', time: 11, turnId: 'g-detach-open' }
    ]);
    const sessionId = opened.sessionId!;

    await closeConversation(conversationId);

    // A detach is not evidence about the turn. It may not end it, and it may not end it
    // "unknown" either: an ended turn is unreachable for the recovery that follows.
    expect(await readEvents(sessionId, { kinds: ['turn_end'] })).toEqual([]);
    const notes = await readEvents(sessionId, { kinds: ['note'] });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.turnId).toBe('g-detach-open');

    const reopened = await recordChatObservations(conversationId, [
      { kind: 'turn_end', time: 30, turnId: 'g-detach-open', outcome: 'completed' }
    ]);
    expect(reopened.sessionId).toBe(sessionId);
    const ends = await readEvents(sessionId, { kinds: ['turn_end'] });
    expect(ends.map((event) => event.kind === 'turn_end' && event.outcome)).toEqual(['completed']);
  });

  it('offers a stable final reply to Goal after reload lost an uncertain turn identity', async () => {
    const conversationId = 'c-goal-final-after-reload';
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'g-before-reload' },
      { kind: 'turn_end', time: 20, turnId: 'g-before-reload', outcome: 'unknown' }
    ]);

    const recovered = await recordChatObservations(conversationId, [{
      kind: 'assistant_message',
      // ChatGPT may stamp the assistant object when generation starts, before a later detach.
      time: 15,
      messageId: 'assistant-stable-after-reload',
      text: 'The complete final answer that appeared after reload.',
      state: 'final',
      final: true
    }]);

    expect(recovered.goalCandidates).toEqual([{
      replyId: 'assistant-stable-after-reload',
      turnId: 'reply:assistant-stable-after-reload',
      eventSeq: expect.any(Number)
    }]);

    const replayed = await recordChatObservations(conversationId, [{
      kind: 'assistant_message',
      time: 15,
      messageId: 'assistant-stable-after-reload',
      text: 'The complete final answer that appeared after reload.',
      state: 'final',
      final: true
    }]);
    expect(replayed.goalCandidates).toEqual(recovered.goalCandidates);
    const [storedFinal] = await readEvents(recovered.sessionId!, { kinds: ['assistant_message'] });
    expect(storedFinal?.kind === 'assistant_message' && storedFinal.goalEligible).toBe(true);
  });

  it('does not turn a historical final answer into Goal work merely because a chat was opened', async () => {
    const conversationId = 'c-goal-historical-final';
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 100, turnId: 'g-newer-uncertain' },
      { kind: 'turn_end', time: 200, turnId: 'g-newer-uncertain', outcome: 'unknown' }
    ]);
    const recovered = await recordChatObservations(conversationId, [{
      kind: 'assistant_message',
      time: 30,
      messageId: 'assistant-historical-final',
      text: 'An answer from an already idle chat.',
      state: 'final',
      final: true
    }]);

    expect(recovered.goalCandidates).toEqual([]);
  });

  it('uses the stable final when it and the uncertain end arrive in the same browser batch', async () => {
    const recovered = await recordChatObservations('c-goal-final-same-batch', [
      { kind: 'turn_start', time: 10, turnId: 'g-same-batch' },
      {
        kind: 'assistant_message',
        time: 15,
        messageId: 'assistant-final-same-batch',
        text: 'Complete despite the page losing its finish edge.',
        state: 'final',
        final: true
      },
      { kind: 'turn_end', time: 20, turnId: 'g-same-batch', outcome: 'unknown' }
    ]);

    expect(recovered.goalCandidates).toEqual([expect.objectContaining({
      replyId: 'assistant-final-same-batch',
      turnId: 'reply:assistant-final-same-batch'
    })]);
  });

  it('does not spend an earlier uncertain boundary while a newer turn is still open', async () => {
    const conversationId = 'c-goal-newer-turn-open';
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 10, turnId: 'g-old-uncertain' },
      { kind: 'turn_end', time: 20, turnId: 'g-old-uncertain', outcome: 'unknown' }
    ]);
    const current = await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: 30, turnId: 'g-new-open' },
      {
        kind: 'assistant_message',
        time: 35,
        messageId: 'assistant-while-new-open',
        text: 'Do not decide this turn before its own terminal boundary.',
        state: 'final',
        final: true
      }
    ]);

    expect(current.goalCandidates).toEqual([]);
  });

  it('does not advance seq or summary state when the durable append fails', async () => {
    const summary = await createSession({ title: 'append failure is not an event' });
    const append = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(
        appendEvent(summary.id, {
          time: 10,
          source: 'extension',
          kind: 'user_message',
          message: { text: 'phantom', truncated: false, chars: 7 }
        })
      ).rejects.toThrow('disk full');
    } finally {
      append.mockRestore();
    }

    const afterFailure = await getSession(summary.id);
    expect(afterFailure?.events).toBe(0);
    expect(afterFailure?.userMessages).toBe(0);
    expect(await readEvents(summary.id)).toHaveLength(0);

    const written = await appendEvent(summary.id, {
      time: 11,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'real', truncated: false, chars: 4 }
    });
    expect(written.seq).toBe(1);
    expect((await getSession(summary.id))?.events).toBe(1);
  });

  it('shares one disk reconstruction across concurrent callers after a restart', async () => {
    const summary = await createSession({ title: 'concurrent reopen' });
    resetSessionStoreForTests();

    const written = await Promise.all([
      appendEvent(summary.id, {
        time: 20,
        source: 'app',
        kind: 'note',
        message: { text: 'first concurrent writer', truncated: false, chars: 23 }
      }),
      appendEvent(summary.id, {
        time: 21,
        source: 'app',
        kind: 'note',
        message: { text: 'second concurrent writer', truncated: false, chars: 24 }
      })
    ]);

    expect(written.map((event) => event.seq).sort((a, b) => a - b)).toEqual([1, 2]);
    expect((await readEvents(summary.id)).map((event) => event.seq)).toEqual([1, 2]);
  });

  it('skips a torn final line and keeps appending after it', async () => {
    const summary = await createSession({ title: 'recovery' });
    await appendEvent(summary.id, {
      time: 1,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'first', truncated: false, chars: 5 }
    });
    await appendEvent(summary.id, {
      time: 2,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'second', truncated: false, chars: 6 }
    });

    // Exactly what a crash mid-append leaves behind: a line with no closing brace.
    const file = path.join(sessionsRoot(), summary.id, 'events.jsonl');
    await fs.appendFile(file, '{"seq":3,"kind":"user_mess', 'utf8');
    resetSessionStoreForTests();

    const recovered = await readEvents(summary.id);
    expect(recovered).toHaveLength(2);

    await appendEvent(summary.id, {
      time: 4,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'third', truncated: false, chars: 5 }
    });
    const all = await readEvents(summary.id);
    expect(all).toHaveLength(3);
    // The number after a torn line must not collide with one already used.
    expect(new Set(all.map((event) => event.seq)).size).toBe(3);
    expect(all[2]!.seq).toBeGreaterThan(all[1]!.seq);
  });

  it('recovers the prior sequence behind a near-limit torn final line', async () => {
    const summary = await createSession({ title: 'large torn tail recovery' });
    const prior = await appendEvent(summary.id, {
      time: 1,
      source: 'extension',
      kind: 'chat_error',
      message: { text: 'durable predecessor', truncated: false, chars: 19 }
    });
    const file = path.join(sessionsRoot(), summary.id, 'events.jsonl');
    // Larger than the historical 128 KiB restart window, but still within the maximum
    // amount a crash can leave from one otherwise legal event line.
    await fs.appendFile(file, `{"seq":${prior.seq + 1},"kind":"chat_error","padding":"${'x'.repeat(400 * 1024)}`, 'utf8');
    resetSessionStoreForTests();

    const next = await appendEvent(summary.id, {
      time: 2,
      source: 'extension',
      kind: 'chat_error',
      message: { text: 'after restart', truncated: false, chars: 13 }
    });

    expect(next.seq).toBe(prior.seq + 1);
    expect((await readEvents(summary.id)).map((event) => event.seq)).toEqual([prior.seq, next.seq]);
  });

  it('recovers a session whose meta.json is gone', async () => {
    const summary = await createSession({ title: 'no meta' });
    await appendEvent(summary.id, { time: 1, source: 'extension', kind: 'turn_start' });
    resetSessionStoreForTests();
    await fs.rm(path.join(sessionsRoot(), summary.id, 'meta.json'), { force: true });

    await appendEvent(summary.id, { time: 2, source: 'extension', kind: 'turn_end', outcome: 'completed' });
    const events = await readEvents(summary.id);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it('reconciles durable journal state when a crash loses the debounced metadata write', async () => {
    const summary = await createSession({ title: 'stale meta journal recovery' });
    const handoffId = '2026-08-25-crash001';
    await appendEvent(summary.id, { time: 10, source: 'extension', kind: 'turn_start', turnId: 'turn-crash' });
    await appendEvent(summary.id, {
      time: 11,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'durable before the crash', truncated: false, chars: 24 }
    });
    await appendEvent(summary.id, {
      time: 12,
      source: 'extension',
      kind: 'chat_error',
      message: { text: 'also durable', truncated: false, chars: 12 }
    });
    await saveHandoff({
      id: handoffId,
      sessionId: summary.id,
      createdAt: 13,
      text: 'TASK — recover this durable handoff',
      sourceEvents: 3,
      sourceTokens: 10,
      notes: []
    });
    await appendEvent(summary.id, {
      time: 13,
      source: 'app',
      kind: 'handoff',
      handoffId,
      chars: 34,
      reason: 'manual'
    });

    const staleMeta = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), summary.id, 'meta.json'), 'utf8')
    ) as { events: number; lastHandoffId: string | null };
    expect(staleMeta.events).toBe(0);
    expect(staleMeta.lastHandoffId).toBeNull();

    // Simulate process death before the 1.5 s metadata debounce fires. The next mutation opens
    // from disk and must project the four already-durable records before applying sequence 5.
    resetSessionStoreForTests();
    const afterCrash = await appendEvent(summary.id, {
      time: 14,
      source: 'app',
      kind: 'note',
      message: { text: 'after restart', truncated: false, chars: 13 }
    });
    expect(afterCrash.seq).toBe(5);

    const recovered = await getSession(summary.id);
    expect(recovered).toMatchObject({
      events: 5,
      userMessages: 1,
      errors: 1,
      activeTurnId: 'turn-crash',
      lastHandoffId: handoffId,
      lastHandoffAt: 13
    });
  });

  it('repairs a stale metadata projection on the first read after restart without a new mutation', async () => {
    const summary = await createSession({ title: 'read-only crash recovery' });
    const handoffId = '2026-08-25-readonly1';
    await appendEvent(summary.id, { time: 30, source: 'extension', kind: 'turn_start', turnId: 'turn-read' });
    await appendEvent(summary.id, {
      time: 31,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'survived on disk', truncated: false, chars: 16 }
    });
    await saveHandoff({
      id: handoffId,
      sessionId: summary.id,
      createdAt: 32,
      text: 'TASK — read-only recovery',
      sourceEvents: 2,
      sourceTokens: 8,
      notes: []
    });
    await appendEvent(summary.id, {
      time: 32,
      source: 'app',
      kind: 'handoff',
      handoffId,
      chars: 25,
      reason: 'manual'
    });

    const metaPath = path.join(sessionsRoot(), summary.id, 'meta.json');
    expect(JSON.parse(await fs.readFile(metaPath, 'utf8'))).toMatchObject({ events: 0, lastHandoffId: null });

    // Simulate process death before the metadata debounce. There is deliberately no append,
    // reopen or other mutation after reset: merely opening history must repair the projection.
    resetSessionStoreForTests();
    const recovered = await getSession(summary.id);
    expect(recovered).toMatchObject({
      events: 3,
      userMessages: 1,
      activeTurnId: 'turn-read',
      lastHandoffId: handoffId,
      lastHandoffAt: 32
    });
    expect(JSON.parse(await fs.readFile(metaPath, 'utf8'))).toMatchObject({
      events: 3,
      userMessages: 1,
      lastHandoffId: handoffId
    });
  });

  const toolCall = (callId: string, tool: string, outcome: string, metric: string | undefined, seq: number) => ({
    time: 100 + seq,
    source: 'app' as const,
    kind: 'tool_call' as const,
    call: {
      callId,
      tool,
      attribution: 'unattributed' as const,
      requestId: null,
      conversationId: null,
      attributionMethod: 'unattributed' as const,
      args: { text: '{}', truncated: false, chars: 2 },
      result: { text: 'ok', truncated: false, chars: 2 },
      outcome: outcome as ToolOutcome,
      durationMs: 1,
      summary: { title: callId, tone: 'neutral' as const, kind: 'run' as const, ...(metric ? { metric } : {}) }
    }
  });

  it('charges the reliability count for a defect here and for nothing else', async () => {
    const summary = await createSession({ title: 'reliability numerator' });
    await appendEvent(summary.id, toolCall('clean', 'exec_command', 'ok', undefined, 1));
    await appendEvent(summary.id, toolCall('failing-build', 'exec_command', 'process_exit_nonzero', undefined, 2));
    await appendEvent(summary.id, toolCall('refused', 'apply_patch', 'tool_rejected', undefined, 3));
    expect(await getSession(summary.id)).toMatchObject({ toolCalls: 3, errors: 0 });

    await appendEvent(summary.id, toolCall('broken', 'exec_command', 'tool_internal_error', undefined, 4));
    expect(await getSession(summary.id)).toMatchObject({
      toolCalls: 4,
      processExitNonzero: 1,
      toolRejected: 1,
      toolInternalErrors: 1,
      errors: 1
    });
  });

  it('re-derives outcome counters for a session recorded before the taxonomy existed', async () => {
    const summary = await createSession({ title: 'legacy outcome projection' });
    await appendEvent(summary.id, toolCall('legacy-exit', 'exec_command', 'error', '✕ exit 7', 1));
    await appendEvent(summary.id, toolCall('legacy-refusal', 'apply_patch', 'rejected', 'refused', 2));
    await appendEvent(summary.id, toolCall('legacy-ambiguous', 'read', 'error', undefined, 3));
    await flushSessions();

    const metaPath = path.join(sessionsRoot(), summary.id, 'meta.json');
    const stored = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
    delete stored.processExitNonzero;
    delete stored.toolRejected;
    delete stored.toolInternalErrors;
    stored.errors = 3;
    await fs.writeFile(metaPath, JSON.stringify(stored, null, 2), 'utf8');

    resetSessionStoreForTests();
    const expected = { processExitNonzero: 1, toolRejected: 1, toolInternalErrors: 0, errors: 0 };
    expect(await getSession(summary.id)).toMatchObject({ toolCalls: 3, ...expected });
    expect(JSON.parse(await fs.readFile(metaPath, 'utf8'))).toMatchObject(expected);

    const outcomes = (await readEvents(summary.id))
      .filter((event): event is Extract<SessionEvent, { kind: 'tool_call' }> => event.kind === 'tool_call')
      .map((event) => event.call.outcome);
    expect(outcomes).toEqual(['error', 'rejected', 'error']);
  });

  it('reconciles a canonical message revision newer than the metadata checkpoint', async () => {
    const summary = await createSession({ title: 'stale meta canonical recovery' });
    const messageId = 'canonical-crash-revision';
    await upsertMessageEvent(summary.id, {
      time: 20,
      source: 'extension',
      kind: 'user_message',
      messageId,
      message: { text: 'small', truncated: false, chars: 5 }
    });
    await flushSessions();

    const revised = await upsertMessageEvent(summary.id, {
      time: 21,
      source: 'extension',
      kind: 'user_message',
      messageId,
      message: { text: 'x'.repeat(400), truncated: false, chars: 400 }
    });
    const checkpoint = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), summary.id, 'meta.json'), 'utf8')
    ) as { estimatedTokens: number };
    expect(checkpoint.estimatedTokens).toBeLessThan(eventTokens(revised.event));

    resetSessionStoreForTests();
    const afterCrash = await appendEvent(summary.id, {
      time: 22,
      source: 'app',
      kind: 'note',
      message: { text: 'open recovered state', truncated: false, chars: 20 }
    });
    expect(afterCrash.seq).toBe(revised.event.seq + 1);

    const recovered = await getSession(summary.id);
    expect(recovered?.events).toBe(2);
    expect(recovered?.userMessages).toBe(1);
    const expectedTokens = eventTokens(revised.event) + eventTokens(afterCrash);
    expect(recovered?.estimatedTokens).toBe(expectedTokens);
    expect(recovered?.contextTokens).toBe(expectedTokens);
  });

  it('repairs a canonical message revision while building the read-only session list after restart', async () => {
    const summary = await createSession({ title: 'catalog crash recovery' });
    const messageId = 'canonical-read-only-revision';
    await upsertMessageEvent(summary.id, {
      time: 40,
      source: 'extension',
      kind: 'user_message',
      messageId,
      message: { text: 'tiny', truncated: false, chars: 4 }
    });
    await flushSessions();

    const revised = await upsertMessageEvent(summary.id, {
      time: 41,
      source: 'extension',
      kind: 'user_message',
      messageId,
      message: { text: 'r'.repeat(800), truncated: false, chars: 800 }
    });
    resetSessionStoreForTests();

    const listed = (await listSessions()).find((entry) => entry.id === summary.id);
    expect(listed?.userMessages).toBe(1);
    expect(listed?.events).toBe(1);
    expect(listed?.estimatedTokens).toBe(eventTokens(revised.event));
    expect(listed?.contextTokens).toBe(eventTokens(revised.event));
  });

  it('stores assets once per content and refuses a malformed asset id', async () => {
    const summary = await createSession({ title: 'assets' });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const first = await writeAsset(summary.id, png, 'image/png');
    const second = await writeAsset(summary.id, png, 'image/png');
    expect(second.id).toBe(first.id);
    expect(first.id.endsWith('.png')).toBe(true);

    const files = await fs.readdir(path.join(sessionsRoot(), summary.id, 'assets'));
    expect(files).toHaveLength(1);
    expect(await readAsset(summary.id, first.id)).toEqual(png);
    expect(await readAsset(summary.id, '../../../config.json')).toBeNull();
  });

  it('keeps automatic compaction ready above the line across interrupted and later turns', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
    try {
      const summary = await createSession({ title: 'auto level', conversationId: 'conv-auto-level' });
      await appendEvent(summary.id, { time: 1, source: 'extension', kind: 'turn_start', turnId: 't-1' });
      await appendEvent(summary.id, {
        time: 2,
        source: 'extension',
        kind: 'user_message',
        messageId: 'u1',
        turnId: 't-1',
        message: { text: 'a'.repeat(44_000), truncated: false, chars: 44_000 }
      });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);

      await appendEvent(summary.id, { time: 3, source: 'extension', kind: 'turn_end', turnId: 't-1', outcome: 'interrupted' });
      await appendEvent(summary.id, { time: 4, source: 'extension', kind: 'turn_start', turnId: 't-2' });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
    } finally {
      await saveConfig(base);
    }
  });

  it('offers nothing while the switch is off or below the line', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: false, autoTokens: 10_000 } });
    try {
      const summary = await createSession({ title: 'off', conversationId: 'conv-auto-off' });
      await appendEvent(summary.id, {
        time: 1,
        source: 'extension',
        kind: 'user_message',
        messageId: 'u1',
        message: { text: 'a'.repeat(44_000), truncated: false, chars: 44_000 }
      });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(false);

      await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 4_000_000 } });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(false);

      await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
      expect(autoCompactionReady(await getSession(summary.id))).toBe(true);
    } finally {
      await saveConfig(base);
    }
  });

  it('keeps the level ready across a close and reopen so a later generation can retry', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, compaction: { ...base.compaction, auto: true, autoTokens: 10_000 } });
    try {
      const summary = await createSession({ title: 'reopened', conversationId: 'conv-auto-reopen' });
      await appendEvent(summary.id, {
        time: 1,
        source: 'extension',
        kind: 'user_message',
        messageId: 'u1',
        message: { text: 'r'.repeat(44_000), truncated: false, chars: 44_000 }
      });
      await endSession(summary.id);
      await reopenSession(summary.id);
      const reopened = await getSession(summary.id);
      expect(autoCompactionReady(reopened)).toBe(true);
    } finally {
      await saveConfig(base);
    }
  });
});

// ---------------------------------------------------------------- handoffs

describe('handoff storage', () => {
  const handoff = (sessionId: string, id: string, createdAt: number) => ({
    id,
    sessionId,
    createdAt,
    model: 'deepseek/test',
    reasoning: 'medium',
    text: 'TASK — finish the thing',
    sourceEvents: 3,
    sourceTokens: 120,
    notes: []
  });

  it('saves, reads back and reports the newest across sessions', async () => {
    const older = await createSession({ title: 'older' });
    const newer = await createSession({ title: 'newer' });
    await saveHandoff(handoff(older.id, '2026-01-01-aaaaaaaa', 1000));
    await saveHandoff(handoff(newer.id, '2026-01-02-bbbbbbbb', 2000));
    await appendEvent(older.id, {
      time: 1000,
      source: 'app',
      kind: 'handoff',
      handoffId: '2026-01-01-aaaaaaaa',
      chars: 23,
      reason: 'manual'
    });
    await appendEvent(newer.id, {
      time: 2000,
      source: 'app',
      kind: 'handoff',
      handoffId: '2026-01-02-bbbbbbbb',
      chars: 23,
      reason: 'resume'
    });

    expect((await readHandoff(older.id, '2026-01-01-aaaaaaaa'))?.text).toContain('TASK');
    expect((await latestHandoff())?.id).toBe('2026-01-02-bbbbbbbb');
    expect((await getSession(newer.id))?.lastHandoffId).toBe('2026-01-02-bbbbbbbb');
    await deleteSession(older.id);
    await deleteSession(newer.id);
  });

  it('reports a durable handoff after restart even when meta.json missed its debounced projection', async () => {
    const summary = await createSession({ title: 'handoff crash recovery' });
    const handoffId = '2026-08-25-crash002';
    await saveHandoff(handoff(summary.id, handoffId, 3_000));
    await appendEvent(summary.id, {
      time: 3_000,
      source: 'app',
      kind: 'handoff',
      handoffId,
      chars: 23,
      reason: 'manual'
    });

    const staleMeta = JSON.parse(
      await fs.readFile(path.join(sessionsRoot(), summary.id, 'meta.json'), 'utf8')
    ) as { lastHandoffId: string | null };
    expect(staleMeta.lastHandoffId).toBeNull();

    resetSessionStoreForTests();
    expect((await latestHandoff())?.id).toBe(handoffId);
    expect((await getSession(summary.id))?.lastHandoffId).toBe(handoffId);
    await deleteSession(summary.id);
  });

  it('finds the newest handoff even when its session is beyond the 5,000-folder maintenance cap', async () => {
    const seed = await createSession({ title: 'handoff catalog seed' });
    const seedSummary = await getSession(seed.id);
    expect(seedSummary).not.toBeNull();
    resetSessionStoreForTests();

    const names = Array.from({ length: 5001 }, (_, index) => `handoff-${String(index).padStart(5, '0')}`);
    const targetId = names.at(-1)!;
    const handoffId = '2026-08-24-deadbeef';
    const realReaddir = fs.readdir.bind(fs);
    const realReadFile = fs.readFile.bind(fs);
    const rootPath = sessionsRoot();
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(
      (async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        if (String(target) === rootPath) return names;
        return (realReaddir as (...callArgs: unknown[]) => ReturnType<typeof fs.readdir>)(target, ...args);
      }) as typeof fs.readdir
    );
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(
      (async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        const file = String(target);
        const id = path.basename(path.dirname(file));
        if (file.endsWith('meta.json') && id.startsWith('handoff-')) {
          return JSON.stringify({
            ...seedSummary,
            id,
            title: id,
            updatedAt: id === targetId ? 20_000 : 10_000,
            lastHandoffId: id === targetId ? handoffId : null,
            lastHandoffAt: id === targetId ? 20_000 : null
          });
        }
        if (file.endsWith(`${path.sep}handoffs${path.sep}${handoffId}.json`)) {
          return JSON.stringify(handoff(targetId, handoffId, 20_000));
        }
        return (realReadFile as (...callArgs: unknown[]) => ReturnType<typeof fs.readFile>)(target, ...args);
      }) as typeof fs.readFile
    );

    try {
      expect((await latestHandoff())?.id).toBe(handoffId);
    } finally {
      readdirSpy.mockRestore();
      readSpy.mockRestore();
      await deleteSession(seed.id);
    }
  }, 90_000);

  it('never prunes the session holding the newest handoff', async () => {
    const stale = await createSession({ title: 'stale' });
    const kept = await createSession({ title: 'kept' });
    await saveHandoff(handoff(kept.id, '2026-01-03-cccccccc', Date.now()));
    await appendEvent(kept.id, {
      time: Date.now(),
      source: 'app',
      kind: 'handoff',
      handoffId: '2026-01-03-cccccccc',
      chars: 23,
      reason: 'manual'
    });

    // Age both sessions past the retention window by rewriting their summaries.
    // Flushed first: the test seam forgets state without writing meta.json.
    await flushSessions();
    resetSessionStoreForTests();
    const long = Date.now() - 90 * 24 * 3600_000;
    for (const id of [stale.id, kept.id]) {
      const metaPath = path.join(sessionsRoot(), id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(metaPath, JSON.stringify({ ...meta, updatedAt: long }), 'utf8');
    }

    const removed = await pruneSessions(30);
    expect(removed).toBeGreaterThanOrEqual(1);
    // Retention is not the UI's first 200 rows. Check durable existence directly so this
    // invariant stays valid even when the retained handoff is intentionally old in a large
    // test history.
    expect(await getSession(kept.id)).not.toBeNull();
    expect(await getSession(stale.id)).toBeNull();
    await deleteSession(kept.id);
  }, 90_000);

  it('prunes an expired session beyond the old 5,000-folder maintenance prefix', async () => {
    const seed = await createSession({ title: 'retention catalog seed' });
    const seedSummary = await getSession(seed.id);
    expect(seedSummary).not.toBeNull();
    resetSessionStoreForTests();

    const names = Array.from({ length: 5001 }, (_, index) => `prune-${String(index).padStart(5, '0')}`);
    const targetId = names.at(-1)!;
    const recent = Date.now();
    const expired = recent - 90 * 24 * 3600_000;
    const rootPath = sessionsRoot();
    const realReaddir = fs.readdir.bind(fs);
    const realReadFile = fs.readFile.bind(fs);
    const realStat = fs.stat.bind(fs);
    const realRm = fs.rm.bind(fs);
    const removed: string[] = [];

    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(
      (async (target: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
        const location = String(target);
        if (location === rootPath) return names;
        if (path.basename(location) === 'messages' && path.basename(path.dirname(location)).startsWith('prune-')) return [];
        return (realReaddir as (...callArgs: unknown[]) => ReturnType<typeof fs.readdir>)(target, ...args);
      }) as typeof fs.readdir
    );
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(
      (async (target: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
        const file = String(target);
        const id = path.basename(path.dirname(file));
        if (id.startsWith('prune-') && file.endsWith('meta.json')) {
          return JSON.stringify({
            ...seedSummary,
            id,
            title: id,
            updatedAt: id === targetId ? expired : recent,
            endedAt: recent,
            conversationId: null,
            chatIds: [],
            lastHandoffId: null,
            lastHandoffAt: null,
            __historySeq: 0
          });
        }
        if (id.startsWith('prune-') && file.endsWith('messages.json')) return '{}';
        return (realReadFile as (...callArgs: unknown[]) => ReturnType<typeof fs.readFile>)(target, ...args);
      }) as typeof fs.readFile
    );
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(
      (async (target: Parameters<typeof fs.stat>[0], ...args: unknown[]) => {
        const file = String(target);
        if (path.basename(path.dirname(file)).startsWith('prune-') && file.endsWith('events.jsonl')) {
          const error = Object.assign(new Error('synthetic missing journal'), { code: 'ENOENT' });
          throw error;
        }
        return (realStat as (...callArgs: unknown[]) => ReturnType<typeof fs.stat>)(target, ...args);
      }) as typeof fs.stat
    );
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(
      (async (target: Parameters<typeof fs.rm>[0], ...args: unknown[]) => {
        const id = path.basename(String(target));
        if (id.startsWith('prune-')) {
          removed.push(id);
          return;
        }
        return (realRm as (...callArgs: unknown[]) => ReturnType<typeof fs.rm>)(target, ...args);
      }) as typeof fs.rm
    );

    try {
      expect(await pruneSessions(30)).toBe(1);
      expect(removed).toEqual([targetId]);
    } finally {
      rmSpy.mockRestore();
      statSpy.mockRestore();
      readSpy.mockRestore();
      readdirSpy.mockRestore();
      resetSessionStoreForTests();
      await deleteSession(seed.id);
    }
  });

  it('splits a long brief on blank lines and keeps every character', () => {
    const blocks = Array.from({ length: 40 }, (_, i) => `SECTION ${i}\n${'detail '.repeat(20)}`);
    const text = blocks.join('\n\n');
    const parts = chunkText(text, 500);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(500);
    expect(parts.join('\n\n')).toBe(text);
  });

  it('splits a single oversized block rather than returning it whole', () => {
    const parts = chunkText('x'.repeat(2500), 1000);
    expect(parts).toHaveLength(3);
    expect(parts.join('')).toHaveLength(2500);
  });

  it('returns one part when the brief already fits', () => {
    expect(chunkText('short brief', 1000)).toEqual(['short brief']);
  });

  it('asks for user-authoritative handoffs up to the documented 30k-token ceiling', () => {
    const prompt = nativeHandoffPrompt();
    expect(prompt).toContain(HANDOFF_BRIEF_RULES);
    expect(prompt).toMatch(/user's messages as the highest-authority source/i);
    expect(prompt).toMatch(/10,000[–-]30,000 tokens/i);
    expect(prompt).toMatch(/~6,000-token brief is normally too short/i);
    expect(prompt).toMatch(/Never exceed 30,000 tokens/i);
    expect(prompt).toMatch(/lossless operational compression/i);
    expect(prompt).toMatch(/failure.*root cause.*change.*verification/i);
    expect(prompt).toMatch(/PLANNED \/ DECIDED/i);
    expect(prompt).toMatch(/FAILED \/ UNRESOLVED/i);
    expect(prompt).toMatch(/VERIFICATION/i);
    expect(prompt).toMatch(/completed and verified/i);
  });
});

// ---------------------------------------------------------------- recorder

describe('canonical recorder 1.8', () => {
  it('lets the store deduplicate repeated recorder assets instead of shadow-counting the same bytes toward quota', async () => {
    const conversationId = `conv-dedup-shot-${Date.now()}`;
    const sessionId = await sessionForConversation(conversationId);
    const requestIds = Array.from({ length: 25 }, (_, index) => `wfr_dedup_asset_${index}`);
    const now = Date.now();
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: now, turnId: 'dedup-asset-turn' },
      {
        kind: 'tool_evidence',
        time: now + 1,
        turnId: 'dedup-asset-turn',
        calls: requestIds.map((requestId, index) => ({
          messageId: `dedup-asset-${index}`,
          tool: 'screenshot',
          order: index,
          answered: false,
          requestId
        }))
      }
    ]);

    // Exactly one maximum-sized file exists on disk. Twenty-five references total 200 MiB
    // logically, which used to trip recorder.ts's separate 192 MiB shadow counter even though
    // the authoritative content-addressed store correctly charged only the first 8 MiB.
    const imageBase64 = Buffer.alloc(MAX_ASSET_BYTES, 0x5a).toString('base64');
    const assetIds: Array<string | undefined> = [];
    for (const [index, requestId] of requestIds.entries()) {
      const call = await recordToolCall({
        tool: 'screenshot',
        args: { index },
        content: [{ type: 'image', data: imageBase64, mimeType: 'image/png' }],
        outcome: 'ok',
        durationMs: 1,
        startedAt: now + 2 + index,
        requestId
      });
      assetIds.push(call?.assets?.[0]?.id);
    }

    expect(assetIds.every(Boolean)).toBe(true);
    expect(new Set(assetIds).size).toBe(1);
    expect((await readEvents(sessionId!, { kinds: ['tool_call'] }))).toHaveLength(25);
  });

  it('deduplicates replayed turn lifecycle boundaries from the at-least-once browser journal', async () => {
    const conversationId = 'conv-lifecycle-replay';
    const batch = [
      { kind: 'turn_start' as const, time: 100, turnId: 'g-replayed-lifecycle' },
      { kind: 'turn_end' as const, time: 200, turnId: 'g-replayed-lifecycle', outcome: 'completed' as const }
    ];
    const first = await recordChatObservations(conversationId, batch);
    await recordChatObservations(conversationId, batch);

    const lifecycle = await readEvents(first.sessionId!, { kinds: ['turn_start', 'turn_end'] });
    expect(lifecycle.map((event) => event.kind)).toEqual(['turn_start', 'turn_end']);
    expect(lifecycle.map((event) => event.turnId)).toEqual(['g-replayed-lifecycle', 'g-replayed-lifecycle']);
  });

  it('serializes concurrent replays before lifecycle dedupe is decided', async () => {
    const conversationId = 'conv-lifecycle-concurrent-replay';
    const batch = [
      { kind: 'turn_start' as const, time: 100, turnId: 'g-concurrent-lifecycle' },
      { kind: 'turn_end' as const, time: 200, turnId: 'g-concurrent-lifecycle', outcome: 'completed' as const }
    ];
    const [first] = await Promise.all([
      recordChatObservations(conversationId, batch),
      recordChatObservations(conversationId, batch)
    ]);

    const lifecycle = await readEvents(first.sessionId!, { kinds: ['turn_start', 'turn_end'] });
    expect(lifecycle.map((event) => event.kind)).toEqual(['turn_start', 'turn_end']);
  });

  it('does not mark a lifecycle retry duplicate before its durable append commits', async () => {
    const conversationId = 'conv-lifecycle-commit-failure';
    const sessionId = await sessionForConversation(conversationId);
    const start = { kind: 'turn_start' as const, time: 100, turnId: 'g-retry-after-disk-failure' };
    const append = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(recordChatObservations(conversationId, [start])).rejects.toThrow('disk full');
    } finally {
      append.mockRestore();
    }

    await recordChatObservations(conversationId, [start]);
    const lifecycle = await readEvents(sessionId!, { kinds: ['turn_start'] });
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]?.turnId).toBe(start.turnId);
  });

  const tool = (requestId: string, startedAt = Date.now()) =>
    recordToolCall({
      tool: 'read',
      args: { paths: ['/project/a.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok' as const,
      durationMs: 1,
      startedAt,
      requestId
    });

  it('creates exactly one session when the same conversation is first observed concurrently', async () => {
    const conversationId = 'conv-concurrent-first-sight';
    const [first, second] = await Promise.all([
      sessionForConversation(conversationId),
      sessionForConversation(conversationId)
    ]);
    expect(second).toBe(first);
    expect((await listSessions()).filter((entry) => entry.conversationId === conversationId)).toHaveLength(1);
    expect(await readEvents(first!, { kinds: ['session_start'] })).toHaveLength(1);
  });

  it('many streaming updates become exactly one final canonical message', async () => {
    const conversationId = 'conv-canonical-stream';
    const messageId = 'msg-stream-123';
    const result = await recordChatObservations(conversationId, [
      { kind: 'assistant_message', time: 100, messageId, text: 'I inspected', renderedHtml: '<p>I inspected</p>', state: 'streaming' },
      { kind: 'assistant_message', time: 110, messageId, text: 'I inspected the current tree', renderedHtml: '<p>I inspected the current tree</p>', state: 'streaming' },
      { kind: 'assistant_message', time: 120, messageId, text: 'I inspected the current tree.', renderedHtml: '<p><strong>I inspected</strong> the current tree.</p>', state: 'final', final: true }
    ]);

    const messages = await readEvents(result.sessionId!, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(1);
    const message = messages[0]!;
    expect(message.kind).toBe('assistant_message');
    if (message.kind !== 'assistant_message') throw new Error('wrong event');
    expect(message.messageId).toBe(messageId);
    expect(message.state).toBe('final');
    expect(message.final).toBe(true);
    expect(message.message.text).toBe('I inspected the current tree.');
    expect(message.renderedHtml?.text).toBe('<p><strong>I inspected</strong> the current tree.</p>');
  });

  it('repeating the same final snapshot never creates another logical message', async () => {
    const conversationId = 'conv-repeat-final';
    const snapshot = {
      kind: 'assistant_message' as const,
      time: 200,
      messageId: 'msg-repeat-final',
      text: 'Done.',
      renderedHtml: '<p>Done.</p>',
      state: 'final' as const,
      final: true
    };
    const first = await recordChatObservations(conversationId, [snapshot]);
    await recordChatObservations(conversationId, [{ ...snapshot, time: 210 }, { ...snapshot, time: 220 }]);
    const messages = await readEvents(first.sessionId!, { kinds: ['assistant_message'] });
    expect(messages).toHaveLength(1);
  });

  it('correlates every hidden or rowless MCP request independently by request id', async () => {
    const conversationId = 'conv-rowless-modern';
    const sessionId = await sessionForConversation(conversationId);
    const now = Date.now();
    await recordChatObservations(conversationId, [
      {
        kind: 'tool_evidence',
        time: now,
        fiberConversationId: conversationId,
        calls: Array.from({ length: 5 }, (_unused, index) => ({
          messageId: `hidden-${index}`,
          tool: 'read',
          order: index,
          answered: false,
          requestId: `wfr_hidden_${index}`
        }))
      }
    ]);
    for (let index = 0; index < 5; index++) await tool(`wfr_hidden_${index}`, now + index);
    const calls = await readEvents(sessionId!, { kinds: ['tool_call'] });
    expect(calls).toHaveLength(5);
    for (const event of calls) {
      if (event.kind !== 'tool_call') throw new Error('wrong event');
      expect(event.call.attributionMethod).toBe('request_id');
      expect(event.call.conversationId).toBe(conversationId);
      expect(event.call.requestId).toMatch(/^wfr_hidden_/);
    }
  });

  it('never cross-attributes concurrent same-tool calls from two chats', async () => {
    const now = Date.now();
    const firstId = 'conv-concurrent-a';
    const secondId = 'conv-concurrent-b';
    const first = await sessionForConversation(firstId);
    const second = await sessionForConversation(secondId);
    await recordChatObservations(firstId, [{
      kind: 'tool_evidence', time: now, fiberConversationId: firstId,
      calls: [{ messageId: 'call-a', tool: 'read', order: 0, answered: false, requestId: 'wfr_concurrent_a' }]
    }]);
    await recordChatObservations(secondId, [{
      kind: 'tool_evidence', time: now, fiberConversationId: secondId,
      calls: [{ messageId: 'call-b', tool: 'read', order: 0, answered: false, requestId: 'wfr_concurrent_b' }]
    }]);

    await Promise.all([tool('wfr_concurrent_b', now), tool('wfr_concurrent_a', now)]);
    const firstCalls = await readEvents(first!, { kinds: ['tool_call'] });
    const secondCalls = await readEvents(second!, { kinds: ['tool_call'] });
    expect(firstCalls).toHaveLength(1);
    expect(secondCalls).toHaveLength(1);
    expect(firstCalls[0]!.kind === 'tool_call' && firstCalls[0]!.call.requestId).toBe('wfr_concurrent_a');
    expect(secondCalls[0]!.kind === 'tool_call' && secondCalls[0]!.call.requestId).toBe('wfr_concurrent_b');
  });

  it('keeps an unmatched modern request unattributed and never borrows another chat', async () => {
    vi.useFakeTimers();
    try {
      const other = await sessionForConversation('conv-other-evidence');
      await recordChatObservations('conv-other-evidence', [{
        kind: 'tool_evidence', time: Date.now(), fiberConversationId: 'conv-other-evidence',
        calls: [{ messageId: 'other-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_other' }]
      }]);
      const pending = tool('wfr_missing', Date.now());
      await vi.advanceTimersByTimeAsync(15_100);
      const call = await pending;
      expect(call?.attributionMethod).toBe('unattributed');
      expect(call?.conversationId).toBeNull();
      expect(await readEvents(other!, { kinds: ['tool_call'] })).toHaveLength(0);
      const unattributed = (await listSessions()).find((entry) => entry.title === 'Unattributed activity');
      expect(unattributed?.toolCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects URL/Fiber conversation conflicts instead of choosing either identity', async () => {
    const now = Date.now();
    await sessionForConversation('conv-url-identity');
    await sessionForConversation('conv-fiber-identity');
    await recordChatObservations('conv-url-identity', [{
      kind: 'tool_evidence',
      time: now,
      fiberConversationId: 'conv-fiber-identity',
      calls: [{ messageId: 'conflict-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_identity_conflict' }]
    }]);
    const call = await tool('wfr_identity_conflict', now);
    expect(call?.attributionMethod).toBe('unattributed');
    expect(call?.conversationId).toBeNull();
  });

  /**
   * One line, and not a problem line.
   *
   * A refused claim means the registry did its job: the id keeps the chat that proved it and
   * every call under it keeps arriving there. Reporting that as a fault put a run that was
   * working perfectly into the problem count, and reporting it once per call put it there
   * thirty-five times over.
   */
  it('reports a refused claim once per batch, and as a note rather than a problem', async () => {
    const firstConversation = 'conv-conflict-log-first';
    const secondConversation = 'conv-conflict-log-second';
    const requestId = `wfr_conflict_log_${Date.now()}`;
    const now = Date.now();
    await sessionForConversation(firstConversation);
    await sessionForConversation(secondConversation);
    await recordChatObservations(firstConversation, [{
      kind: 'tool_evidence',
      time: now,
      fiberConversationId: firstConversation,
      calls: [{ messageId: 'first-proof', tool: 'read', order: 0, answered: true, requestId }]
    }]);

    const lines = (level: 'warn' | 'info'): number => getLog().filter(
      (entry) => entry.level === level && entry.message.includes(`${requestId} stays with conversation`)
    ).length;
    const conflictingCalls = Array.from({ length: 35 }, (_, index) => ({
      messageId: `conflicting-call-${index}`,
      tool: index % 2 === 0 ? 'read' : 'exec_command',
      order: index,
      answered: true,
      requestId
    }));
    await recordChatObservations(secondConversation, [{
      kind: 'tool_evidence',
      time: now + 1,
      fiberConversationId: secondConversation,
      calls: conflictingCalls
    }]);
    expect(lines('info')).toBe(1);
    expect(lines('warn')).toBe(0);

    // And the id still belongs to the chat that proved it, which is the whole point of having
    // refused: a call arriving under it now is filed there, not left unattributed.
    const call = await tool(requestId, now + 2);
    expect(call?.attributionMethod).toBe('request_id');
    expect(call?.conversationId).toBe(firstConversation);
  });

  /**
   * A disagreement is a bad moment, not a bad request id.
   *
   * The page can be mid-navigation, still holding the previous chat's model, or showing a
   * conversation whose client-side thread id is not yet the server's. All of those make the
   * URL and the React tree disagree for a tick. Marking the request ids in that batch
   * contradictory — which is what this used to do — is permanent: nothing republishes a
   * conflicted id, and the deterministic repair pass skips it. Whole turns of provable tool
   * calls stayed in Unattributed activity for good because of one transient tick.
   */
  it('lets agreeing evidence prove a call whose first sighting disagreed with the URL', async () => {
    const conversationId = 'conv-late-agreement';
    const sessionId = await sessionForConversation(conversationId);
    const now = Date.now();

    await recordChatObservations(conversationId, [{
      kind: 'tool_evidence',
      time: now,
      fiberConversationId: 'conv-still-the-old-one',
      calls: [{ messageId: 'late-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_late_agreement' }]
    }]);

    // The same sighting a tick later, from a page that now agrees with its own URL.
    await recordChatObservations(conversationId, [{
      kind: 'tool_evidence',
      time: now + 5,
      fiberConversationId: conversationId,
      calls: [{ messageId: 'late-call', tool: 'read', order: 0, answered: false, requestId: 'wfr_late_agreement' }]
    }]);

    const call = await tool('wfr_late_agreement', now + 10);
    expect(call?.attributionMethod).toBe('request_id');
    expect(call?.conversationId).toBe(conversationId);
    expect(await readEvents(sessionId!, { kinds: ['tool_call'] })).toHaveLength(1);
  });

  it('preserves captured rendered Markdown HTML on the canonical transcript message', async () => {
    const html = '<h2>Heading</h2><p><strong>bold</strong> and <em>italic</em></p><pre><code>const x = 1;</code></pre><table><tbody><tr><td>A</td></tr></tbody></table>';
    const result = await recordChatObservations('conv-rendered', [{
      kind: 'assistant_message', time: 300, messageId: 'msg-rendered', text: 'Heading\nbold and italic\nconst x = 1;\nA', renderedHtml: html, state: 'final', final: true
    }]);
    const [message] = await readEvents(result.sessionId!, { kinds: ['assistant_message'] });
    expect(message?.kind === 'assistant_message' && message.renderedHtml?.text).toBe(html);
  });

  it('keeps one message anchored before tool calls while streaming revisions update it', async () => {
    const conversationId = 'conv-interleaved';
    const sessionId = await sessionForConversation(conversationId);
    const now = Date.now();
    await recordChatObservations(conversationId, [{
      kind: 'assistant_message', time: now, messageId: 'msg-interleaved', text: 'Working', renderedHtml: '<p>Working</p>', state: 'streaming'
    }]);
    await recordChatObservations(conversationId, [{
      kind: 'tool_evidence', time: now + 10, fiberConversationId: conversationId,
      calls: [{ messageId: 'tool-interleaved', tool: 'read', order: 0, answered: false, requestId: 'wfr_interleaved' }]
    }]);
    await tool('wfr_interleaved', now + 20);
    await recordChatObservations(conversationId, [{
      kind: 'assistant_message', time: now + 30, messageId: 'msg-interleaved', text: 'Working — done', renderedHtml: '<p>Working — <strong>done</strong></p>', state: 'final', final: true
    }]);
    const timeline = (await readEvents(sessionId!)).filter((event) => event.kind === 'assistant_message' || event.kind === 'tool_call');
    expect(timeline.map((event) => event.kind)).toEqual(['assistant_message', 'tool_call']);
    expect(timeline.filter((event) => event.kind === 'assistant_message')).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ naming

/**
 * What a chat this app opened is called.
 *
 * A session is normally named after the first thing said in it, which for a resumed or
 * worker chat is the bootstrap prompt this app typed itself. The installed build's
 * session list was consequently a column of near-identical rows reading
 * `Continue the previous ChatGPT ...` and `You are worker agent "worker-1" in a ...`,
 * with nothing to say which run any of them belonged to.
 */
describe('naming the chats this app opened', () => {
  const worker: SessionOrigin = {
    kind: 'worker',
    fromSessionId: null,
    agentId: 'worker-1',
    task: 'Port the recorder tests to the new fixture'
  };

  it('names a worker chat for its agent and task', () => {
    expect(originTitle(worker, null)).toBe('worker-1 · Port the recorder tests to the new fixture');
  });

  it('names a resumed chat after the session it continues', () => {
    expect(originTitle({ kind: 'resume', fromSessionId: 's1', agentId: null, task: '' }, 'Fix the bridge')).toBe(
      'Resumed · Fix the bridge'
    );
  });

  // A resumed chat is itself resumable, and a long session is resumed repeatedly.
  it('does not stack the prefix when a resumed chat is resumed again', () => {
    expect(
      originTitle({ kind: 'resume', fromSessionId: 's1', agentId: null, task: '' }, 'Resumed · Fix the bridge')
    ).toBe('Resumed · Fix the bridge');
  });

  it('shortens a task that would otherwise fill the row', () => {
    const long = { ...worker, task: 'x'.repeat(200) };
    expect(originTitle(long, null).length).toBeLessThan(80);
    expect(originTitle(long, null).endsWith('…')).toBe(true);
  });

  it('still names a resume whose source session has been deleted', () => {
    expect(originTitle({ kind: 'resume', fromSessionId: null, agentId: null, task: '' }, null)).toBe(
      'Resumed session'
    );
  });

  /**
   * The ordering that actually happens: the extension acknowledges typing the bootstrap
   * into the fresh tab before that tab has told the app anything about itself, so the
   * origin is known before the session exists.
   */
  it('names the session at creation when the origin arrives first', async () => {
    const source = await createSession({ title: 'Fix the bridge' });
    await noteChatOrigin('conv-fresh', {
      kind: 'resume',
      fromSessionId: source.id,
      agentId: null,
      task: ''
    });
    const sessionId = await recordChatObservations('conv-fresh', [
      {
        kind: 'user_message',
        time: Date.now(),
        text: 'Continue the previous Chat On Steroids session. Read the handoff below.',
        messageId: 'boot-1'
      }
    ]);
    const summary = await getSession(sessionId.sessionId!);
    expect(summary?.title).toBe('Resumed · Fix the bridge');
    expect(summary?.origin?.kind).toBe('resume');
    expect(summary?.origin?.fromSessionId).toBe(source.id);
  });

  /** The other ordering: a slow ack, or a page that reported itself unusually fast. */
  it('renames a session that was already created under the bootstrap prompt', async () => {
    const opened = await recordChatObservations('conv-late', [
      {
        kind: 'user_message',
        time: Date.now(),
        text: 'You are worker agent "worker-1" in a Chat On Steroids run.',
        messageId: 'boot-2'
      }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toContain('worker agent');

    await noteChatOrigin('conv-late', worker);
    const summary = await getSession(opened.sessionId!);
    expect(summary?.title).toBe('worker-1 · Port the recorder tests to the new fixture');
    expect(summary?.origin?.agentId).toBe('worker-1');
  });

  /**
   * A worker's bootstrap stays leased until the worker joins, so the same command can be
   * acknowledged more than once. The second ack must not rename a session whose name has
   * since become somebody else's to choose.
   */
  it('stamps an origin once', async () => {
    const opened = await recordChatObservations('conv-twice', [
      { kind: 'user_message', time: Date.now(), text: 'bootstrap', messageId: 'boot-3' }
    ]);
    await noteChatOrigin('conv-twice', worker);
    await renameSession(opened.sessionId!, 'Renamed by hand');
    await noteChatOrigin('conv-twice', { ...worker, task: 'Something else entirely' });
    expect((await getSession(opened.sessionId!))?.title).toBe('Renamed by hand');
  });

  it('leaves a chat the user started alone', async () => {
    const opened = await recordChatObservations('conv-organic', [
      { kind: 'user_message', time: Date.now(), text: 'why is the bridge flaky', messageId: 'm-1' }
    ]);
    const summary = await getSession(opened.sessionId!);
    expect(summary?.title).toBe('why is the bridge flaky');
    expect(summary?.origin).toBeNull();
  });

  it('promotes only the generic fallback when the first authored user title arrives late', async () => {
    const conversationId = 'conv-late-first-user-title';
    const sessionId = await sessionForConversation(conversationId);
    expect((await getSession(sessionId!))?.title).toBe('ChatGPT session');

    const observed = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'the real opening question', messageId: 'late-first-user' }
    ]);
    expect(observed.sessionId).toBe(sessionId);
    expect((await getSession(sessionId!))?.title).toBe('the real opening question');

    const manualConversation = 'conv-manual-title-before-user';
    const manualSessionId = await sessionForConversation(manualConversation);
    await renameSession(manualSessionId!, 'My chosen title');
    await recordChatObservations(manualConversation, [
      { kind: 'user_message', time: Date.now(), text: 'must not replace manual title', messageId: 'manual-first-user' }
    ]);
    expect((await getSession(manualSessionId!))?.title).toBe('My chosen title');
  });

  it('promotes the first-user fallback to ChatGPT’s real generated conversation title', async () => {
    const conversationId = 'conv-real-page-title';
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'bro fix this exact thing please', messageId: 'title-user-1' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('bro fix this exact thing please');

    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'Fix Local Files Reconstruction' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('Fix Local Files Reconstruction');

    await renameSession(opened.sessionId!, 'My manual title');
    await recordChatObservations(conversationId, [
      { kind: 'conversation_title', time: Date.now(), text: 'A Later ChatGPT Rename' }
    ]);
    expect((await getSession(opened.sessionId!))?.title).toBe('My manual title');
  });

  it('recovers a late worker call agent from the durable worker session origin after live broker state is gone', async () => {
    const conversationId = 'conv-late-worker-call';
    const requestId = 'wfr_late_worker_exact';
    await noteChatOrigin(conversationId, worker);
    const opened = await recordChatObservations(conversationId, [
      { kind: 'user_message', time: Date.now(), text: 'worker bootstrap', messageId: 'worker-boot-late-call' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        fiberConversationId: conversationId,
        calls: [{ messageId: 'worker-late-request', tool: 'read', order: 0, answered: false, requestId }]
      }
    ]);
    const originalSessionId = opened.sessionId!;
    await closeConversation(conversationId);
    expect((await getSession(originalSessionId))?.endedAt).not.toBeNull();

    const call = await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/src/main.ts'] },
      content: [{ type: 'text', text: 'ok' }],
      outcome: 'ok',
      durationMs: 5,
      startedAt: Date.now(),
      requestId,
      // Deliberately contradictory live broker context. Durable request/session epoch wins.
      agent: 'prime'
    });

    expect(call?.conversationId).toBe(conversationId);
    expect(call?.attributionMethod).toBe('request_id');
    const stored = await readEvents(originalSessionId, { kinds: ['tool_call'] });
    expect(stored).toHaveLength(1);
    const recorded = stored[0];
    expect(recorded?.kind === 'tool_call' && recorded.agent).toBe('worker-1');
    expect(recorded?.kind === 'tool_call' && recorded.call.requestId).toBe(requestId);
    // A late request is not evidence that the worker tab or browser conversation reopened.
    expect((await getSession(originalSessionId))?.endedAt).not.toBeNull();
  });

  it('files a retired source chat into its own lineage and refuses its later requests as superseded', async () => {
    const oldConversation = 'conv-worker-before-transfer';
    const newConversation = 'conv-worker-after-transfer';
    const oldRequest = 'wfr_worker_before_transfer';
    const freshRequest = 'wfr_stale_tab_fresh_epoch';
    await noteChatOrigin(oldConversation, worker);
    const original = await recordChatObservations(oldConversation, [
      { kind: 'user_message', time: Date.now(), text: 'worker bootstrap', messageId: 'boot-before-transfer' },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        fiberConversationId: oldConversation,
        calls: [{ messageId: 'old-request-message', tool: 'read', order: 0, answered: false, requestId: oldRequest }]
      }
    ]);
    const originalSessionId = original.sessionId!;

    expect(await rebindSession(originalSessionId, oldConversation, newConversation)).toBe(true);
    rebindConversation(originalSessionId, oldConversation, newConversation);

    // The stale old tab is a retired frontend of the one session, never a chat of its own: its
    // prose files into the lineage (2026-09-02: the brief's late re-render minted a session
    // holding nothing but the summary) and it moves none of the projections B now owns.
    const stale = await recordChatObservations(oldConversation, [
      { kind: 'user_message', time: Date.now(), text: 'stale tab carried on', messageId: 'stale-epoch-user' },
      { kind: 'turn_start', time: Date.now(), turnId: 'g-stale-tab-turn' }
    ]);
    expect(stale.sessionId).toBe(originalSessionId);
    expect(stale.activity).toEqual({ meaningful: false, working: false, terminal: false });
    expect(
      (await readEvents(originalSessionId, { kinds: ['user_message'] })).some(
        (event) => event.kind === 'user_message' && event.messageId === 'stale-epoch-user'
      )
    ).toBe(true);
    expect(await readEvents(originalSessionId, { kinds: ['turn_start'] })).toEqual([]);
    expect((await getSession(originalSessionId))?.conversationId).toBe(newConversation);
    expect((await listSessions()).filter((entry) => entry.chatIds.includes(oldConversation))).toHaveLength(1);

    // Exact proof preserves forensic identity, but it is not execution authority after A was
    // replaced. The call stays out of B's live history.
    await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/old.ts'] },
      content: [{ type: 'text', text: 'old request completed late' }],
      outcome: 'ok',
      durationMs: 10,
      startedAt: Date.now(),
      requestId: oldRequest,
      agent: 'prime'
    });
    const originalCalls = await readEvents(originalSessionId, { kinds: ['tool_call'] });
    expect(originalCalls).toHaveLength(0);
    const buckets = (await listSessions()).filter((entry) => entry.title === 'Unattributed activity');
    let isolated: Extract<SessionEvent, { kind: 'tool_call' }> | undefined;
    let isolatedBucketId = '';
    for (const bucket of buckets) {
      const calls = await readEvents(bucket.id, { kinds: ['tool_call'] });
      const match = calls.find(
        (event): event is Extract<SessionEvent, { kind: 'tool_call' }> =>
          event.kind === 'tool_call' && event.call.requestId === oldRequest
      );
      if (!match) continue;
      isolated = match;
      isolatedBucketId = bucket.id;
      break;
    }
    expect(isolated?.call.attributionMethod).toBe('superseded');
    await repairDeterministicAttribution();
    expect(
      (await readEvents(isolatedBucketId, { kinds: ['tool_call'] })).some(
        (event) => event.kind === 'tool_call' && event.call.requestId === oldRequest
      )
    ).toBe(true);

    // A request first proved in the stale tab after the move is still the retired chat's, so it
    // is refused as superseded — a message that names the handover — instead of waiting out
    // the identity window as nobody's. It lands beside the late one, never in the lineage.
    await recordChatObservations(oldConversation, [
      {
        kind: 'tool_evidence',
        time: Date.now(),
        fiberConversationId: oldConversation,
        calls: [{ messageId: 'fresh-request-message', tool: 'read', order: 0, answered: false, requestId: freshRequest }]
      }
    ]);
    await recordToolCall({
      tool: 'read',
      args: { paths: ['/project/fresh.ts'] },
      content: [{ type: 'text', text: 'fresh request' }],
      outcome: 'ok',
      durationMs: 1,
      startedAt: Date.now(),
      requestId: freshRequest,
      agent: null
    });
    expect(await readEvents(originalSessionId, { kinds: ['tool_call'] })).toHaveLength(0);
    const fresh = (await readEvents(isolatedBucketId, { kinds: ['tool_call'] })).find(
      (event) => event.kind === 'tool_call' && event.call.requestId === freshRequest
    );
    expect(fresh?.kind === 'tool_call' && fresh.call.attributionMethod).toBe('superseded');
    expect((await listSessions()).filter((entry) => entry.chatIds.includes(oldConversation))).toHaveLength(1);
  });

  it('does not publish or return stale A→S first-sight state after S durably rebinds to B', async () => {
    const oldConversation = `conv-init-old-${Date.now()}`;
    const newConversation = `conv-init-new-${Date.now()}`;
    const summary = await createSession({ conversationId: oldConversation, title: 'racing restore' });

    const realOpen = fs.open.bind(fs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedRead!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedRead = resolve;
    });
    let paused = false;
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(
      (async (target: Parameters<typeof fs.open>[0], ...args: unknown[]) => {
        if (!paused && String(target) === path.join(sessionsRoot(), summary.id, 'events.jsonl')) {
          paused = true;
          reachedRead();
          await gate;
        }
        return (realOpen as (...callArgs: unknown[]) => ReturnType<typeof fs.open>)(target, ...args);
      }) as typeof fs.open
    );

    try {
      const staleInitialization = sessionForConversation(oldConversation);
      await reached;

      expect(await rebindSession(summary.id, oldConversation, newConversation)).toBe(true);
      rebindConversation(summary.id, oldConversation, newConversation);
      release();

      expect(await staleInitialization).toBeNull();
      expect((await getSession(summary.id))?.conversationId).toBe(newConversation);
      expect(liveConversations().find((entry) => entry.conversationId === oldConversation)).toBeUndefined();
      expect(liveConversations().find((entry) => entry.conversationId === newConversation)?.sessionId).toBe(summary.id);
    } finally {
      release();
      openSpy.mockRestore();
    }
  });
});

// --------------------------------------------------------------- summaries

describe('tool summaries', () => {
  const summarize = (tool: string, args: unknown, patch: Partial<ReturnType<typeof emptyEvidence>> = {}, outcome: ToolOutcome = 'ok', durationMs = 10) =>
    summarizeToolCall({ tool, args, evidence: evidence(patch), outcome, durationMs, resultHead: 'head line' });

  /** The patch text a summary reads its intent off. */
  const patch = (header: string, path: string): string =>
    `*** Begin Patch\n*** ${header}: ${path}\n*** End Patch`;

  it('names one edited file and totals several', () => {
    const one = summarize('apply_patch', { patch: patch('Update File', '/p/src/a.ts') }, {
      changes: [{ path: '/p/src/a.ts', added: 18, removed: 4, approximate: false }]
    });
    expect(one.title).toBe('Edited src/a.ts');
    expect(one.metric).toBe('+18 −4');

    const many = summarize('apply_patch', { patch: patch('Update File', '/p/a.ts') }, {
      changes: [
        { path: '/p/a.ts', added: 40, removed: 9, approximate: false },
        { path: '/p/b.ts', added: 32, removed: 10, approximate: false }
      ]
    });
    expect(many.title).toBe('Edited 2 files');
    expect(many.metric).toBe('+72 −19');
  });

  it('marks an approximate diffstat rather than pretending it is exact', () => {
    const summary = summarize('apply_patch', { patch: patch('Update File', '/p/big.ts') }, {
      changes: [{ path: '/p/big.ts', added: 4000, removed: 3000, approximate: true }]
    });
    expect(summary.metric).toBe('~+4000 −3000');
  });

  // One tool now covers create, edit, move and delete, so the title has to come from what
  // the patch did. A timeline that said "Applied a patch" four times would be useless.
  it('tells creates, deletes and moves apart from the patch itself', () => {
    expect(summarize('apply_patch', { patch: patch('Add File', '/p/src/history.ts') }, {
      changes: [{ path: '/p/src/history.ts', added: 214, removed: 0, approximate: false }]
    })).toMatchObject({ title: 'Created src/history.ts', metric: '+214', kind: 'create' });

    expect(summarize('apply_patch', { patch: patch('Delete File', '/p/old-helper.ts') }, {
      changes: [{ path: '/p/old-helper.ts', added: 0, removed: 83, approximate: false }]
    })).toMatchObject({ title: 'Deleted old-helper.ts', metric: '−83', tone: 'warn', kind: 'delete' });

    const moved = summarize(
      'apply_patch',
      { patch: '*** Begin Patch\n*** Move to: /p/new.ts\n*** End Patch' },
      { changes: [{ path: '/p/new.ts', added: 0, removed: 0, approximate: false }] }
    );
    expect(moved).toMatchObject({ title: 'Moved new.ts', kind: 'move' });

    // A patch that both adds and updates is simply an edit; it must not claim to be a create.
    const mixed = summarize(
      'apply_patch',
      { patch: `${patch('Add File', '/p/a.ts')}\n*** Update File: /p/b.ts` },
      {
        changes: [
          { path: '/p/a.ts', added: 5, removed: 0, approximate: false },
          { path: '/p/b.ts', added: 1, removed: 1, approximate: false }
        ]
      }
    );
    expect(mixed.kind).toBe('edit');
  });

  it('describes a read by its paths and range', () => {
    expect(summarize('read', { paths: ['/p/tools.ts'], start_line: 200, end_line: 420 })).toMatchObject({
      title: 'Read tools.ts',
      detail: 'lines 200–420',
      metric: '221 lines'
    });
    expect(
      summarize('read', { paths: ['/p/tools.ts'], start_line: 200, end_line: 420 }, { detail: 'lines 200–237' })
    ).toMatchObject({ detail: 'lines 200–237', metric: '38 lines' });
    expect(summarize('read', { paths: ['/p/a.ts', '/p/b.ts', '/p/c.ts'] })).toMatchObject({
      title: 'Read 3 paths',
      detail: 'a.ts, b.ts, c.ts'
    });
  });

  it('reports how a command exited', () => {
    expect(summarize('exec_command', { cmd: 'npm run verify' }, { exitCode: 0, durationMs: 4800 })).toMatchObject({
      title: 'Ran npm run verify',
      metric: '✓ 4.8s',
      tone: 'good'
    });
    const failed = summarize('exec_command', { cmd: 'npm test' }, { exitCode: 1, durationMs: 900 });
    expect(failed.title).toContain('Command failed');
    expect(failed.metric).toBe('✕ exit 1');
    expect(failed.tone).toBe('bad');
    expect(summarize('exec_command', { cmd: 'sleep 100' }, { exitCode: null, timedOut: true }).metric).toBe(
      '✕ timed out'
    );
    expect(
      summarize('exec_command', { cmd: 'npm run verify' }, { exitCode: null, durationMs: 10_000 })
    ).toMatchObject({ title: 'Started npm run verify', metric: 'running', tone: 'neutral' });
  });

  it('says which way a session was interrupted', () => {
    expect(summarize('write_stdin', { session_id: 'p1', signal: 'kill' })).toMatchObject({
      title: 'Stopped session p1',
      tone: 'warn'
    });
    expect(summarize('write_stdin', { session_id: 'p1', signal: 'int' }).title).toBe('Interrupted session p1');
    expect(summarize('write_stdin', { session_id: 'p1', chars: 'y\n' }).title).toBe('Wrote to session p1');
    expect(summarize('write_stdin', { session_id: 'p1' }).title).toBe('Waited on session p1');
  });

  it('keeps the subject but not the claim when a call fails or is refused', () => {
    const refused = summarize('apply_patch', { patch: patch('Delete File', '/p/x.ts') }, {
      changes: [{ path: '/p/x.ts', added: 0, removed: 3, approximate: false }]
    }, 'tool_rejected');
    expect(refused.title).toBe('Refused to delete x.ts');
    expect(refused.metric).toBe('refused');
    expect(refused.tone).toBe('warn');

    const errored = summarize('apply_patch', { patch: patch('Update File', '/p/x.ts') }, {
      changes: [{ path: '/p/x.ts', added: 1, removed: 1, approximate: false }]
    }, 'tool_internal_error');
    expect(errored.title).toBe('Could not edit x.ts');
    expect(errored.metric).toBe('✕ failed');
    expect(errored.detail).toBe('head line');
    expect(errored.tone).toBe('bad');
  });

  it('says a failed call failed in words, for every tool family', () => {
    const cases: Array<[string, unknown, string]> = [
      ['read', { paths: ['/p/x.ts'] }, 'Could not read x.ts'],
      ['find', { query: 'todo' }, 'Could not search "todo"'],
      ['apply_patch', { patch: patch('Update File', '/p/x.ts') }, 'Could not apply a patch'],
      ['exec_command', { cmd: 'npm test' }, 'Could not run npm test'],
      ['observe', {}, 'Could not look at the screen'],
      ['agents', { action: 'spawn', workers: [{ task: 'a' }, { task: 'b' }] }, 'Could not create 2 worker agents'],
      [
        'agents',
        { action: 'message', messages: [{ to: 'worker-1', text: 'a' }, { to: 'worker-2', text: 'b' }] },
        'Could not message 2 agents'
      ],
      ['agents', { action: 'finish', result: 'done' }, 'Could not report the finished task'],
      ['some_future_tool', {}, 'Could not run some_future_tool']
    ];
    for (const [tool, args, title] of cases) {
      const summary = summarize(tool, args, {}, 'tool_internal_error');
      expect(summary.title, tool).toBe(title);
      // Nothing may still read as an accomplished action.
      expect(summary.title, tool).not.toMatch(/^(Read|Applied|Created|Searched|Ran|Messaged|Reported|Looked) /);
    }
  });

  it('reads the action out of the flat session and agents tools', () => {
    expect(summarize('agents', { action: 'spawn', workers: [{ task: 'a' }, { task: 'b' }] }).title).toBe(
      'Created 2 worker agents'
    );
    expect(summarize('agents', { action: 'message', to: 'worker-2' }).title).toBe('Messaged worker-2');
    expect(summarize('agents', { action: 'status' }).title).toBe('Checked agent status');
    expect(summarize('session', { action: 'search', query: 'tunnel' }).title).toBe(
      'Searched recordings "tunnel"'
    );
    expect(summarize('session', { action: 'search' }).title).toBe('Listed recent recordings');
    expect(summarize('session', { action: 'read', session_id: 'session-one' }).title).toBe(
      'Read a recorded session'
    );
    expect(summarize('session', { action: 'read', session_id: 'session-one', cursor: 'opaque' }).title).toBe(
      'Continued reading a recorded session'
    );
  });

  it('names the desktop action rather than saying "computer"', () => {
    expect(summarize('computer', { actions: [{ type: 'click_ref', ref: 'e1' }] })).toMatchObject({
      title: 'Clicked',
      kind: 'input'
    });
    // Clipboard-only work is not desktop input and should not read as if it were.
    expect(summarize('computer', { actions: [{ type: 'read_clipboard' }] })).toMatchObject({
      title: 'Read the clipboard',
      kind: 'clipboard'
    });
    expect(
      summarize('computer', { actions: [{ type: 'write_clipboard', text: 'x' }, { type: 'keypress', keys: ['ctrl', 'v'] }] })
    ).toMatchObject({ kind: 'input', detail: '2 actions' });
  });

  it('shows the command that actually ran instead of the words "a command"', () => {
    const single = summarize('exec_command', { cmd: 'Get-Process -Name node' }, { exitCode: 0, durationMs: 120 });
    expect(single.title).toBe('Ran Get-Process -Name node');

    const many = summarize(
      'exec_command',
      { cmd: '# find the build\r\nGet-ChildItem -Recurse -Filter *.log\nSelect-Object -First 5' },
      { exitCode: 0, durationMs: 120 }
    );
    // Comments are skipped, the first real line leads, and the rest is signalled.
    expect(many.title).toBe('Ran Get-ChildItem -Recurse -Filter *.log …');

    const long = summarize('exec_command', { cmd: `Write-Output ${'x'.repeat(200)}` }, { exitCode: 0 });
    expect(long.title.length).toBeLessThan(90);
    expect(long.title.endsWith('…')).toBe(true);

    expect(summarize('exec_command', {}, { exitCode: 1, durationMs: 5 }).title).toBe('Command failed a command');
  });

  it('falls back to the tool name rather than "Called tool"', () => {
    expect(summarize('some_future_tool', {}).title).toBe('Ran some_future_tool');
  });
});

// ---------------------------------------------------------------- diffstat

describe('line deltas', () => {
  it('counts a pure insertion and a pure deletion exactly', () => {
    expect(lineDelta('a\nb\n', 'a\nnew\nb\n')).toEqual({ added: 1, removed: 0, approximate: false });
    expect(lineDelta('a\nb\nc\n', 'a\nc\n')).toEqual({ added: 0, removed: 1, approximate: false });
  });

  it('counts a replacement as one added and one removed', () => {
    expect(lineDelta('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ added: 1, removed: 1, approximate: false });
  });

  it('reports nothing for identical text, including a new file', () => {
    expect(lineDelta('same\n', 'same\n')).toEqual({ added: 0, removed: 0, approximate: false });
    expect(lineDelta('', 'one\ntwo\n')).toEqual({ added: 2, removed: 0, approximate: false });
    expect(formatDelta({ added: 0, removed: 0 })).toBeNull();
  });

  it('handles a reordered block without inventing changes', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const after = ['a', 'c', 'b', 'd', 'e'].join('\n');
    expect(lineDelta(before, after)).toEqual({ added: 1, removed: 1, approximate: false });
  });

  it('counts sparse edits exactly even when they are thousands of lines apart', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[10] = 'changed ten';
    after[3500] = 'changed thirty-five hundred';
    expect(lineDelta(before.join('\n'), after.join('\n'))).toEqual({
      added: 2,
      removed: 2,
      approximate: false
    });
  });

  it('normalizes CRLF/LF for sparse large-file counting', () => {
    const before = Array.from({ length: 3200 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[5] = 'changed five';
    after[3000] = 'changed three thousand';
    expect(lineDelta(`${before.join('\r\n')}\r\n`, `${after.join('\n')}\n`)).toEqual({
      added: 2,
      removed: 2,
      approximate: false
    });
  });

  it('says so when a rewrite is too large to diff exactly', () => {
    const before = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 4000 }, (_, i) => `changed ${i}`).join('\n');
    const delta = lineDelta(before, after);
    expect(delta.approximate).toBe(true);
    expect(delta.added).toBe(4000);
  });

  it('formats the metric the way the timeline shows it', () => {
    expect(formatDelta({ added: 18, removed: 4 })).toBe('+18 −4');
    expect(formatDelta({ added: 214, removed: 0 })).toBe('+214');
    expect(formatDelta({ added: 0, removed: 83 })).toBe('−83');
  });
});

// ------------------------------------------------------------------ tokens

describe('token estimation', () => {
  it('is an explicit approximation of local text only', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(4001))).toBe(1001);
  });

  it('weighs an event by the text actually kept', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'mcp',
      kind: 'tool_call',
      call: {
        callId: 'c1',
        tool: 'read_file',
        attribution: 'turn',
        args: { text: 'a'.repeat(400), truncated: false, chars: 400 },
        result: { text: 'b'.repeat(800), truncated: false, chars: 800 },
        outcome: 'ok',
        durationMs: 3,
        summary: { title: 'Read a.ts', tone: 'neutral', kind: 'read' }
      }
    } as SessionEvent;
    expect(eventTokens(event)).toBe(100 + 200 + Math.ceil('Read a.ts'.length / 4));
  });

  it('does not inflate the context advisory with transient progress captions', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'extension',
      kind: 'progress',
      message: { text: 'reasoning status '.repeat(100), truncated: false, chars: 1700 }
    } as SessionEvent;
    expect(eventTokens(event)).toBe(0);
  });

  it('counts a brokered agent message, which the model does read', () => {
    const event = {
      seq: 1,
      time: 1,
      source: 'app',
      kind: 'agent_message',
      messageId: 'm1',
      from: 'worker-1',
      to: 'prime',
      message: { text: 'r'.repeat(1200), truncated: false, chars: 1200 },
      delivery: 'delivered'
    } as SessionEvent;
    expect(eventTokens(event)).toBe(300);
  });

  it('grades pressure against the configured thresholds', () => {
    expect(tokenPressure(50_000, 180_000, 200_000).level).toBe('ok');
    expect(tokenPressure(185_000, 180_000, 200_000).level).toBe('large');
    expect(tokenPressure(220_000, 180_000, 200_000).level).toBe('huge');
  });
});

/**
 * The log is append-only, so a commentary line being written arrives as a run of records
 * under one id. Every reader that is not watching it live wants the opposite: the newest
 * text, once, where the line started.
 */
describe('folding redrawn commentary', () => {
  const progress = (seq: number, progressId: string, text: string, origin?: number): SessionEvent =>
    ({
      seq,
      time: seq,
      source: 'extension',
      kind: 'progress',
      progressId,
      ...(origin === undefined ? {} : { origin }),
      message: { text, truncated: false, chars: text.length }
    }) as SessionEvent;

  it('keeps the newest text at the earliest record’s position', () => {
    const folded = foldProgress([
      progress(1, 'p1', 'Monitoring'),
      progress(2, 'p2', 'Reading'),
      progress(3, 'p1', 'Monitoring the review', 1),
      progress(4, 'p1', 'Wrote the summary', 1)
    ]);

    expect(folded.map((event) => event.seq)).toEqual([1, 2]);
    expect(folded.map((event) => (event as { message: { text: string } }).message.text)).toEqual([
      'Wrote the summary',
      'Reading'
    ]);
  });

  it('leaves everything that is not identified commentary exactly where it was', () => {
    const events: SessionEvent[] = [
      { seq: 1, time: 1, source: 'extension', kind: 'turn_start' } as SessionEvent,
      progress(2, 'p1', 'first'),
      // No id: an older recording, or a page that would not take the stamp. Nothing to fold.
      {
        seq: 3,
        time: 3,
        source: 'extension',
        kind: 'progress',
        message: { text: 'unidentified', truncated: false, chars: 12 }
      } as SessionEvent,
      progress(4, 'p1', 'second', 2),
      { seq: 5, time: 5, source: 'extension', kind: 'turn_end', outcome: 'completed' } as SessionEvent
    ];

    const folded = foldProgress(events);
    expect(folded.map((event) => event.seq)).toEqual([1, 2, 3, 5]);
    expect(foldProgress(events)).toEqual(folded);
    // Non-destructive: the original array is untouched.
    expect(events).toHaveLength(5);
  });
});

/**
 * Where the store writes when nobody has told it where.
 *
 * `root` starts as the empty string, and `path.join('', id)` is a relative path — so an
 * uninitialised store did not fail, it wrote real session folders into the process's
 * working directory. Recording being off by default hid that completely. The moment it
 * was turned on, a test run started leaving recordings scattered through the repository,
 * and the only reason it was noticed was `git status`.
 */
describe('a session store nobody has pointed anywhere', () => {
  afterEach(() => {
    initSessionStore(dir);
  });

  it('refuses to write rather than falling back to the working directory', async () => {
    unsetSessionRootForTests();
    await expect(createSession({ conversationId: null })).rejects.toThrow(/initSessionStore/);
  });

  it('refuses to read as well, instead of reporting an empty history', async () => {
    unsetSessionRootForTests();
    await expect(listSessions()).rejects.toThrow(/initSessionStore/);
  });
});

describe('activity windows', () => {
  /**
   * The label must outlive the reload it triggers.
   *
   * Both durations came from one constant, so the Active badge expired on the same instant the
   * silence ledger did — and the browser action still had this app's sweep and Chrome's alarm
   * ahead of it. What a user saw was a chat going idle and then reloading itself half a minute
   * later for no visible reason. Any future edit that collapses these two back into one number,
   * or reorders them, reproduces that exactly.
   */
  it('keeps the Active badge alive past the silence reload it triggers', () => {
    expect(CHAT_SILENCE_MS).toBe(2 * 60_000);
    expect(CHAT_ACTIVE_MS).toBeGreaterThan(CHAT_SILENCE_MS);
    // Enough headroom for both hops a queued reload still has to make: this app's maintenance
    // tick and the extension's thirty-second alarm floor.
    expect(CHAT_ACTIVE_MS - CHAT_SILENCE_MS).toBeGreaterThanOrEqual(60_000);
  });
});
