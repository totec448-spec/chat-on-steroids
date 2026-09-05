import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { flushDurable, initDurableStore, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import {
  appendEvent,
  createSession,
  initSessionStore,
  resetSessionStoreForTests,
  unsetSessionRootForTests
} from '../src/main/session/store.js';
import {
  observeRequestCorrelation,
  observeRequestCorrelations,
  requestCorrelation,
  restoreRequestCorrelations,
  resetCorrelationRegistryForTests
} from '../src/main/session/correlation.js';

describe('request correlation ownership', () => {
  beforeEach(() => resetCorrelationRegistryForTests());

  it('keeps one turn-level request id owned across different MCP messages and tools', () => {
    const requestId = 'wfr_shared_turn';
    const now = Date.now();
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-read',
        tool: 'read',
        observedAt: now
      })
    ).toBe('stored');
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a-later',
        messageId: 'msg-exec',
        tool: 'exec_command',
        observedAt: now + 1
      })
    ).toBe('same');
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a-later',
        messageId: 'msg-session',
        tool: 'session',
        observedAt: now + 2
      })
    ).toBe('same');

    expect(requestCorrelation(requestId)?.conversationId).toBe('conv-a');
    expect(requestCorrelation(requestId)?.sessionId).toBe('session-a');
  });

  /**
   * The rule the whole registry exists to keep: a request id is bound to a chat once, and then
   * it is that chat's for good.
   *
   * A second conversation claiming a proven id is a page that is wrong about itself - a React
   * tree still mounted from the chat before it, a fresh chat whose client thread id has not
   * caught up. Believing it used to cost the id itself: the entry went permanently unresolved,
   * so every further call of a workflow that was still running waited fifteen seconds for
   * evidence that could no longer be accepted, and landed in Unattributed activity. Refusing
   * the claimant costs the claimant nothing that was ever really theirs.
   */
  it('keeps the first proven owner when a second conversation claims the same request id', () => {
    const requestId = 'wfr_cross_chat';
    const now = Date.now();
    observeRequestCorrelation({
      requestId,
      conversationId: 'conv-a',
      sessionId: 'session-a',
      messageId: 'msg-a',
      tool: 'read',
      observedAt: now
    });
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-a-refresh',
        tool: 'read',
        observedAt: now + 1
      })
    ).toBe('same');
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-b',
        sessionId: 'session-b',
        messageId: 'msg-b',
        tool: 'read',
        observedAt: now + 2
      })
    ).toBe('refused');
    expect(requestCorrelation(requestId)?.conversationId).toBe('conv-a');
    expect(requestCorrelation(requestId)?.sessionId).toBe('session-a');

    // And the owner is still an owner afterwards, not a survivor in a degraded state: its own
    // later sightings keep being accepted exactly as they were before anyone argued.
    expect(
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-a',
        sessionId: 'session-a',
        messageId: 'msg-a-later',
        tool: 'exec_command',
        observedAt: now + 3
      })
    ).toBe('same');
    expect(requestCorrelation(requestId)?.observedAt).toBe(now + 3);
  });

  it('does not age a proven request owner out just because the page evidence is old', () => {
    const requestId = 'wfr_long_running_workflow';
    observeRequestCorrelation({
      requestId,
      conversationId: 'conv-a',
      sessionId: 'session-a',
      messageId: 'msg-a',
      tool: 'exec_command',
      // Deliberately ancient. 1.8.1 forgot this after ten minutes and started filing later
      // calls from the same still-running workflow into Unattributed activity.
      observedAt: 1
    });

    expect(requestCorrelation(requestId)?.conversationId).toBe('conv-a');
  });

  it('evicts by latest same-owner observation rather than original insertion order', () => {
    const refreshedId = 'wfr_refreshed_old_request';
    const correlation = (requestId: string, observedAt: number) => ({
      requestId,
      conversationId: 'conv-a',
      sessionId: 'session-a',
      messageId: `msg-${requestId}`,
      tool: 'read',
      observedAt
    });

    // Fill the bounded registry exactly. The request we care about is deliberately the oldest
    // insertion, then is observed again immediately before one new id forces an eviction.
    observeRequestCorrelations([
      correlation(refreshedId, 1),
      ...Array.from({ length: 49_999 }, (_, index) => correlation(`wfr_fill_${index}`, index + 2))
    ]);
    expect(
      observeRequestCorrelation({
        ...correlation(refreshedId, 100_000),
        messageId: 'msg-refreshed'
      })
    ).toBe('same');

    observeRequestCorrelation(correlation('wfr_newest', 100_001));

    expect(requestCorrelation(refreshedId)?.conversationId).toBe('conv-a');
    expect(requestCorrelation(refreshedId)?.observedAt).toBe(100_000);
    expect(requestCorrelation('wfr_fill_0')).toBeNull();
  });

  it('keeps the owner of a workflow whose calls are still arriving after its page went quiet', () => {
    // The permanence contract's hardest case, and the one the header is written for: the MCP
    // side keeps issuing calls under a request id after the page that proved it was reloaded,
    // compacted or closed. No further page observation is ever coming, so observation order
    // alone parks that workflow at the eviction head — the registry would discard precisely the
    // owner least able to refresh itself, while ids nobody is using any more stay. A lookup is
    // the other liveness signal, so being called under counts as being alive.
    const liveId = 'wfr_still_calling';
    const correlation = (requestId: string, observedAt: number) => ({
      requestId,
      conversationId: 'conv-live',
      sessionId: 'session-a',
      messageId: `msg-${requestId}`,
      tool: 'read',
      observedAt
    });

    // The live workflow is the oldest insertion and is never observed again.
    observeRequestCorrelations([
      correlation(liveId, 1),
      ...Array.from({ length: 49_999 }, (_, index) => correlation(`wfr_quiet_${index}`, index + 2))
    ]);

    // Its calls keep arriving. This is the only evidence it will ever produce again.
    expect(requestCorrelation(liveId)?.conversationId).toBe('conv-live');

    // One more id forces an eviction. It must not be this one.
    observeRequestCorrelation(correlation('wfr_newest', 100_001));

    expect(requestCorrelation(liveId)?.conversationId).toBe('conv-live');
    // The id nothing has touched since it was stored is the one that goes.
    expect(requestCorrelation('wfr_quiet_0')).toBeNull();
  });

  it('restores proven request ownership from durable state after an app restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const requestId = 'wfr_survives_restart';
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-durable',
        sessionId: 'session-durable',
        messageId: 'msg-durable',
        tool: 'read',
        observedAt: 123
      });
      await flushDurable();

      resetCorrelationRegistryForTests();
      expect(requestCorrelation(requestId)).toBeNull();

      await restoreRequestCorrelations();
      expect(requestCorrelation(requestId)?.conversationId).toBe('conv-durable');
      expect(requestCorrelation(requestId)?.sessionId).toBe('session-durable');
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * ChatGPT publishes `metadata.request_id` before the `api_tool` message that names the tool,
   * and the bridge stores that early sighting with an empty tool on purpose: the join never uses
   * the name, and waiting for it is what used to file the call under Unattributed activity. Two
   * such rows sat in the live 2026-09-01 registry. Both would have been thrown away on the next
   * launch by a validity check stricter than the registry's own answer, taking the proven owner
   * of a workflow whose calls could still be arriving.
   */
  it('restores an owner proved by a request id ChatGPT had not yet given a tool name', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-untooled-'));
    try {
      resetDurableForTests();
      initDurableStore(dir);
      const requestId = '93c113a1-16a6-439d-bda1-cfcd4f2e39d6';
      observeRequestCorrelation({
        requestId,
        conversationId: 'conv-bare-request-id',
        sessionId: '2026-09-01-dd2e9210',
        messageId: '88056b37-984c-4428-9f69-a4aa5bbbf7ac',
        tool: '',
        observedAt: 1_788_276_631_192
      });
      await flushDurable();

      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();

      expect(requestCorrelation(requestId)?.conversationId).toBe('conv-bare-request-id');
      expect(requestCorrelation(requestId)?.sessionId).toBe('2026-09-01-dd2e9210');
    } finally {
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('migrates older proven owners and forgets the sticky conflicts those versions wrote', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-v3-conflict-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      await writeDurableNow('request-correlations', {
        version: 3,
        entries: [
          {
            requestId: 'wfr_v3_proven_owner',
            value: {
              requestId: 'wfr_v3_proven_owner',
              conversationId: 'conv-v3-proven',
              sessionId: 'session-v3-proven',
              messageId: 'message-v3-proven',
              tool: 'read',
              observedAt: 100
            },
            conflicted: false
          },
          {
            requestId: 'wfr_v3_false_conflict',
            value: null,
            conflicted: true
          }
        ]
      });

      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_v3_proven_owner')?.conversationId).toBe('conv-v3-proven');
      // Forgotten, not restored as a verdict: the id is simply unproved again, and the next page
      // that proves it owns it.
      expect(requestCorrelation('wfr_v3_false_conflict')).toBeNull();
      expect(
        observeRequestCorrelation({
          requestId: 'wfr_v3_false_conflict',
          conversationId: 'conv-after-migration',
          sessionId: 'session-after-migration',
          messageId: 'message-after-migration',
          tool: 'read',
          observedAt: 200
        })
      ).toBe('stored');
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds the first 1.8.2 owner index from already-attributed session history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-migrate-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);

      const session = await createSession({ title: 'old attributed history', conversationId: 'conv-history' });
      await appendEvent(session.id, {
        time: 200,
        source: 'mcp',
        kind: 'tool_call',
        call: {
          callId: 'call-history',
          tool: 'read',
          attribution: 'request_id',
          requestId: 'wfr_history',
          conversationId: 'conv-history',
          attributionMethod: 'request_id',
          args: { text: '{}', truncated: false, chars: 2 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok',
          durationMs: 1,
          summary: { kind: 'read', tone: 'neutral', title: 'Read history' }
        }
      });

      resetCorrelationRegistryForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_history')?.conversationId).toBe('conv-history');
      expect(requestCorrelation('wfr_history')?.sessionId).toBe(session.id);

      await flushDurable();
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_history')?.conversationId).toBe('conv-history');
      expect(requestCorrelation('wfr_history')?.sessionId).toBe(session.id);
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reconciles a valid stale snapshot with newer durable attributed history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clf-correlation-stale-'));
    try {
      resetDurableForTests();
      resetSessionStoreForTests();
      initDurableStore(dir);
      initSessionStore(dir);
      const conversationId = 'conv-stale-reconcile';
      const session = await createSession({ title: 'stale correlation snapshot', conversationId });
      const toolCall = (callId: string, requestId: string, time: number) => ({
        time,
        source: 'mcp' as const,
        kind: 'tool_call' as const,
        call: {
          callId,
          tool: 'read',
          attribution: 'request_id' as const,
          requestId,
          conversationId,
          attributionMethod: 'request_id' as const,
          args: { text: '{}', truncated: false, chars: 2 },
          result: { text: 'ok', truncated: false, chars: 2 },
          outcome: 'ok' as const,
          durationMs: 1,
          summary: { kind: 'read' as const, tone: 'neutral' as const, title: callId }
        }
      });

      observeRequestCorrelation({
        requestId: 'wfr_old_snapshot',
        conversationId,
        sessionId: session.id,
        messageId: 'msg-old',
        tool: 'read',
        observedAt: 1
      });
      await appendEvent(session.id, toolCall('call-old', 'wfr_old_snapshot', 1));
      await flushDurable(); // saved index contains only the old request

      observeRequestCorrelation({
        requestId: 'wfr_new_history',
        conversationId,
        sessionId: session.id,
        messageId: 'msg-new',
        tool: 'read',
        observedAt: 2
      });
      await appendEvent(session.id, toolCall('call-new', 'wfr_new_history', 2));
      // Lose process memory before the debounced index write catches up. Session JSONL is
      // already durable, so restore must merge it into the older valid snapshot.
      resetCorrelationRegistryForTests();
      resetDurableForTests();
      initDurableStore(dir);

      await restoreRequestCorrelations();
      expect(requestCorrelation('wfr_old_snapshot')?.conversationId).toBe(conversationId);
      expect(requestCorrelation('wfr_new_history')?.conversationId).toBe(conversationId);
    } finally {
      resetCorrelationRegistryForTests();
      resetSessionStoreForTests();
      unsetSessionRootForTests();
      resetDurableForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
