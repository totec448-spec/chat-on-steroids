import { REASONING_EFFORTS } from '../src/shared/session.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { flushDurable, initDurableStore, readDurable, resetDurableForTests, writeDurableNow } from '../src/main/durable.js';
import {
  inputArgs, acknowledgeBrowserInput, cancelInput, claimBrowserInput, completeBrowserDecision, enqueueInput,
  failBrowserInput, listInputs, offerToolInput as offerToolInputBatch, acknowledgeToolInput, pendingBrowserInputs, requestBrowserDecision, resetInputForTests, configureInputDelivery,
  authorizeBrowserHelperRetry, pausedBrowserHelpers, hasEligibleToolInput, editQueuedInput, reorderQueuedInputs, setInputAutomation, authorizeBrowserInput, sessionInputPolicy
} from '../src/main/session/input.js';
import type { InputArgs, InputEntry } from '../src/main/session/input.js';
import { noteChatOrigin } from '../src/main/session/recorder.js';
import { listUsageSessions } from '../src/main/session/store.js';
import { trackInFlight, emptyEvidence, type CallContext } from '../src/main/mcp/call-context.js';
// Ownership tests inspect messages; batch-specific assertions use the complete delivery below.
const offerToolInput = async (...args: Parameters<typeof offerToolInputBatch>) => (await offerToolInputBatch(...args)).messages;
vi.mock('../src/main/session/recorder.js', () => ({ noteChatOrigin: vi.fn(async () => undefined) }));

const binding = vi.hoisted(() => ({ origin: 'desktop', conversationId: 'conversation-a', blocked: false, recorded: true, activeTurnId: null as string | null, lastToolCallAt: null as number | null, finishEnabled: true, finishReleased: false, model: 'gpt-6-astra', leadMinutes: 5, impulseMinutes: 0, end: null as null | { kind: string; outcome: string; reason?: string; turnId: string; time: number } }));
vi.mock('../src/main/session/store.js', () => ({
  listUsageSessions: vi.fn(async () => []),
  conversationWasSuperseded: vi.fn(async () => false),
  readRecentEvents: vi.fn(async () => binding.end ? [binding.end] : []),
  turnHasMcpCall: vi.fn(async () => true),
  getSession: vi.fn(async (id: string) => ({ id, conversationId: id === 'session-two' ? 'conversation-b' : binding.conversationId, activeTurnId: binding.activeTurnId,
    origin: { kind: binding.origin }, lastToolCallAt: binding.lastToolCallAt,
    finishTurn: { turnId: binding.activeTurnId, released: binding.finishReleased },
    selectedModel: { conversationId: id === 'session-two' ? 'conversation-b' : binding.conversationId, model: binding.model } })),
  findSessionByConversation: vi.fn(async (id: string) => binding.recorded && id === binding.conversationId ? { id: 'session-one', conversationId: id } : null)
}));
vi.mock('../src/main/config.js', () => ({ getConfig: () => ({ ui: { finishTool: binding.finishEnabled, finishAction: 'goal', finishLeadMinutes: binding.leadMinutes }, goal: { impulseMinutes: binding.impulseMinutes } }) }));
vi.mock('../src/main/session/blocked-chats.js', () => ({ isChatBlocked: () => binding.blocked }));
let directory: string;
let now: number;
const automate = vi.fn(async (_conversationId: string, _automation: string, _phase: string) => undefined);
const changed = vi.fn();
const sessionId = 'session-one';
function input(overrides: Partial<InputArgs> = {}): InputArgs {
  return { id: randomUUID(), sessionId, text: 'Please inspect this', mode: 'auto', dueAt: 0, model: null, reasoningEffort: null, ...overrides };
}
/** Previously persisted queues remain readable even though new direct admission is one at a time. */
async function seedLegacyInput(args: InputArgs): Promise<InputEntry> {
  const row: InputEntry = { ...args, state: 'queued', owner: null, createdAt: now, conversationId: args.sessionId ? binding.conversationId : null };
  await writeDurableNow('session-input', [...await listInputs(), row]);
  resetInputForTests();
  return row;
}
beforeEach(async () => {
  vi.mocked(noteChatOrigin).mockClear();
  resetInputForTests();
  automate.mockReset();
  changed.mockReset();
  configureInputDelivery({ applyAutomation: automate, changed });
  resetDurableForTests();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-input-'));
  initDurableStore(directory);
  binding.conversationId = 'conversation-a';
  binding.blocked = false;
  binding.origin = 'desktop';
  binding.recorded = true;
  binding.activeTurnId = null;
  binding.lastToolCallAt = null;
  binding.finishEnabled = true; binding.finishReleased = false; binding.model = 'gpt-6-astra'; binding.leadMinutes = 5; binding.impulseMinutes = 0;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'previous-turn', time: 0 };
  now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetInputForTests();
  resetDurableForTests();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('durable user input ownership', () => {
  it('preserves messages beyond the former composer limit through admission, restart and browser claim', async () => {
    binding.finishEnabled = false;
    const text = 'Long user request. '.repeat(2000);
    const row = await enqueueInput(input({ text }));
    resetInputForTests();
    expect((await listInputs())[0]?.text).toBe(text.trim());
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId)).toMatchObject({ text: text.trim(), deliveryText: text.trim() });
  });
  it('edits queued text beyond 16000 characters while retaining the message transport ceiling', async () => {
    const row = await enqueueInput(input({ mode: 'after-turn' }));
    const text = 'x'.repeat(32_000);
    expect(await editQueuedInput(row.id, text)).toBe(true);
    expect((await listInputs())[0]?.text).toBe(text);
    await expect(editQueuedInput(row.id, 'x'.repeat(96_001))).rejects.toThrow();
    expect((await listInputs())[0]?.text).toBe(text);
    expect(inputArgs.safeParse(input({ text: 'x'.repeat(96_001) })).success).toBe(false);
  });
  it('sends a tool-free non-Pro correction through one durable browser claim and native receipt', async () => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'plain-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'plain-turn', time: 900 };
    binding.lastToolCallAt = 800; // Earlier turns do not change this turn's menu.
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: false, directTurn: { id: 'plain-turn', startedAt: 900 } });
    const direct = await enqueueInput(input());
    expect(direct).toMatchObject({ transportIntent: 'browser', directTurn: { id: 'plain-turn' } });
    expect(await pendingBrowserInputs()).toEqual([expect.objectContaining({ id: direct.id, directTurn: direct.directTurn })]);
    const claim = await claimBrowserInput(direct.id, 'native-page', binding.conversationId, true);
    expect(claim?.directTurn).toEqual(direct.directTurn);
    expect(await offerToolInput(sessionId, binding.conversationId, 'racing-tool', now)).toEqual([]);
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'stopped', turnId: 'plain-turn', time: 1001 };
    expect(await authorizeBrowserInput(direct.id, 'native-page', binding.conversationId)).toBe(true);
    expect(await authorizeBrowserInput(direct.id, 'native-page', binding.conversationId)).toBe(false);
    expect(await acknowledgeBrowserInput(direct.id, 'native-page', binding.conversationId, 'native-message')).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', messageId: 'native-message' });
  });

  it.each(['gpt-5-pro', 'gpt-5.6-pro', 'gpt-6-astra', 'gpt-6-pro'])('keeps %s on MCP injection before its first call', async model => {
    binding.model = model; binding.activeTurnId = 'pro-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'pro-turn', time: 900 };
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: true, directTurn: null });
    expect(await enqueueInput(input())).toMatchObject({ transportIntent: 'tool' });
    expect(await pendingBrowserInputs()).toEqual([]);
  });

  it.each(['pro', 'unknown'] as const)('does not interrupt %s turn ownership after the picker changes to Sol', async model => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'original-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'original-turn', time: 900 };
    expect(await sessionInputPolicy(sessionId, { exact: true, possible: true, model })).toMatchObject({ canInject: true, directTurn: null });
  });

  it.each(['tool', 'turn', 'rebind', 'blocked'])('revokes an unsubmitted direct correction after %s changes', async change => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'plain-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'plain-turn', time: 900 };
    const direct = await enqueueInput(input());
    await claimBrowserInput(direct.id, 'native-page', binding.conversationId, true);
    if (change === 'tool') binding.lastToolCallAt = 950;
    if (change === 'turn') { binding.activeTurnId = 'new-turn'; binding.end = { ...binding.end, turnId: 'new-turn', time: 1001 }; }
    if (change === 'rebind') binding.conversationId = 'conversation-b';
    if (change === 'blocked') binding.blocked = true;
    expect(await authorizeBrowserInput(direct.id, 'native-page', 'conversation-a')).toBe(false);
  });

  it('switches at the first running MCP call, retains injection afterward, and resets on the next turn', async () => {
    binding.model = 'gpt-5.6-sol'; binding.activeTurnId = 'plain-turn';
    binding.end = { kind: 'turn_start', outcome: '', turnId: 'plain-turn', time: 900 };
    const context: CallContext = { startedAt: 950, transportKey: null, agent: null, outcome: null,
      caller: { conversationId: binding.conversationId, requestId: 'first-call', transportKey: null }, evidence: emptyEvidence() };
    await trackInFlight(context, async () => {
      expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: true, directTurn: null });
      binding.lastToolCallAt = 950;
    });
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: true, directTurn: null });
    binding.activeTurnId = 'next-turn'; binding.end = { ...binding.end, turnId: 'next-turn', time: 1001 };
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ canInject: false, directTurn: { id: 'next-turn' } });
    const after = await enqueueInput(input({ mode: 'after-turn' }));
    expect(after.directTurn).toBeUndefined();
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'later-tool', now)).toEqual([]);
  });

  it('acknowledges prior tool delivery at call ingress without consuming the next queued stage', async () => {
    const previous = await enqueueInput(input({ text: 'Already delivered' }));
    await offerToolInput(sessionId, binding.conversationId, 'same-server-request', now);
    const nextStage = await enqueueInput(input({ text: 'Still queued', mode: 'finish' }));
    await acknowledgeToolInput(sessionId, binding.conversationId, 'same-server-request', now);
    expect((await listInputs()).find(row => row.id === previous.id)?.state).toBe('tool');
    now += 1;
    await acknowledgeToolInput(sessionId, 'different-conversation', 'same-server-request', now);
    expect((await listInputs()).find(row => row.id === previous.id)?.state).toBe('tool');
    await acknowledgeToolInput(sessionId, binding.conversationId, 'same-server-request', now);
    const rows = await listInputs();
    expect(rows.find(row => row.id === previous.id)).toMatchObject({ state: 'sent', messageId: `input:${previous.id}` });
    expect(rows.find(row => row.id === nextStage.id)?.state).toBe('queued');
    expect(await hasEligibleToolInput(sessionId)).toBe(false);
    expect(await hasEligibleToolInput(sessionId, true)).toBe(true);
  });

  it.each([3, 5])('adds the configured %s-minute reminder once per delivery, preserving each authored message and staged boundary', async lead => {
    binding.leadMinutes = lead;
    const direct = await enqueueInput(input({ text: 'Check the new requirement' }));
    const stage = await enqueueInput(input({ text: 'Verify the next stage', mode: 'finish' }));
    const first = await offerToolInputBatch(sessionId, binding.conversationId, 'ordinary-tool', now, true);
    expect(first.messages).toEqual([{ text: direct.text, images: [] }]);
    expect(first.reminder).toContain(`about ${lead} minutes of final verification remain`);
    expect(first.reminder).toContain('only when the requested implementation is complete');
    expect(first.reminder).toContain('New instructions extend the work; they do not require another finish call');
    now += 1;
    const second = await offerToolInputBatch(sessionId, binding.conversationId, 'finish-tool', now, true);
    expect(second.messages).toEqual([{ text: stage.text, images: [] }]);
    expect(second.reminder).toContain(`about ${lead} minutes of final verification remain`);
    expect(second.reminder.match(/Use session_finish/g)).toHaveLength(1);
    const rows = await listInputs();
    expect(rows.find(row => row.id === direct.id)?.text).toBe('Check the new requirement');
    expect(rows.find(row => row.id === stage.id)?.text).toBe('Verify the next stage');
    expect(rows.find(row => row.id === stage.id)?.deliveryText).toBe('Verify the next stage');
  });
  it.each(['other-model', 'disabled', 'released', 'helper', 'worker'])('does not add an Astra finish reminder when %s', async condition => {
    if (condition === 'other-model') binding.model = 'gpt-5.6-sol';
    if (condition === 'disabled') binding.finishEnabled = false;
    if (condition === 'released') binding.finishReleased = true;
    if (condition === 'helper' || condition === 'worker') binding.origin = condition;
    await enqueueInput(input());
    const result = await offerToolInputBatch(sessionId, binding.conversationId, 'ordinary-tool', now, true);
    expect(result.messages).toHaveLength(1);
    expect(result.reminder).toBe('');
  });

  it('supersedes only the receiving session Goal and preserves another session queued Goal across restart', async () => {
    binding.activeTurnId = 'turn-one';
    const otherGoal = await enqueueInput(input({ text: 'Goal A' }), { turnId: 'turn-one', periodic: false });
    const ownGoal = await enqueueInput(input({ sessionId: 'session-two', text: 'Goal B' }), { turnId: 'turn-one', periodic: false });
    const ownInput = await enqueueInput(input({ sessionId: 'session-two', text: 'Correction for B' }));
    resetInputForTests();
    const rows = await listInputs();
    expect(rows.find(row => row.id === otherGoal.id)).toMatchObject({ state: 'queued', sessionId, conversationId: 'conversation-a' });
    expect(rows.find(row => row.id === ownGoal.id)?.state).toBe('cancelled');
    expect(rows.find(row => row.id === ownInput.id)).toMatchObject({ state: 'queued', sessionId: 'session-two', conversationId: 'conversation-b' });
    expect(await enqueueInput(input({ sessionId: 'session-two', text: 'Another direct instruction' }))).toMatchObject({ state: 'queued' });
  });
  it.each([[sessionId, 60000], ['session-two', 60000], ['session-two', 0]] as const)('does not let unrelated or future input in %s at +%s ms block a completed plan stage', async (scheduledSession, delay) => {
    const stage = await enqueueInput(input({ mode: 'finish', text: 'Next stage A', afterTurn: true }));
    await enqueueInput(input({ sessionId: scheduledSession, dueAt: now + delay, text: 'Later input' }));
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'completed-a', time: now + 1 };
    expect(await pendingBrowserInputs()).toContainEqual({ id: stage.id, conversationId: 'conversation-a' });
  });
  it('keeps due direct input ahead of the same session completed plan stage', async () => {
    const stage = await enqueueInput(input({ mode: 'finish' }));
    const direct = await enqueueInput(input({ text: 'Do this first' }));
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'completed-a', time: now + 1 };
    const pending = await pendingBrowserInputs();
    expect(pending.some(row => row.id === stage.id)).toBe(false);
    expect(pending.some(row => row.id === direct.id)).toBe(true);
  });

  it('delivers one manual input before staged work and preserves the next stage for a later poll', async () => {
    const stage = await enqueueInput(input({ text: 'Stage one', mode: 'finish' }));
    await enqueueInput(input({ text: 'Stage two', mode: 'finish' }));
    await enqueueInput(input({ text: 'Manual correction' }));
    expect((await offerToolInput(sessionId, binding.conversationId, 'poll', now, true))[0]?.text).toContain('Manual correction');
    now += 1;
    const next = await offerToolInput(sessionId, binding.conversationId, 'poll', now, true);
    expect(next).toHaveLength(1);
    expect(next[0]?.text).toBe(stage.text);
    now += 1;
    const last = await offerToolInput(sessionId, binding.conversationId, 'poll', now, true);
    expect(last).toHaveLength(1);
    expect(last[0]?.text).toContain('Stage two');
  });
  it('keeps an automatic Goal for a call started after its enqueue', async () => {
    binding.activeTurnId = 'turn-one';
    await enqueueInput(input(), { turnId: 'turn-one', periodic: false });
    expect(await offerToolInput(sessionId, binding.conversationId, 'running-call', now, true)).toEqual([]);
    now += 1;
    expect(await offerToolInput(sessionId, binding.conversationId, 'next-call', now, true)).toHaveLength(1);
  });

  it.each([false, true])('prioritizes new user input while preserving generated post-wire receipts: offered=%s', async offered => {
    binding.activeTurnId = 'turn-one'; binding.impulseMinutes = 3;
    const generated = await enqueueInput(input({ text: 'Generated instruction' }), { turnId: 'turn-one', periodic: false });
    if (offered) now += 1;
    if (offered) await offerToolInput(sessionId, binding.conversationId, 'first-request', now);
    const user = await enqueueInput(input({ text: 'My newer instruction' }));
    const rows = await listInputs();
    expect(rows.find(row => row.id === generated.id)?.state).toBe(offered ? 'tool' : 'cancelled');
    expect(rows.find(row => row.id === user.id)?.state).toBe('queued');
    now += 100;
    const result = await offerToolInput(sessionId, binding.conversationId, 'next-request', now);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toContain('My newer instruction');
    expect(result[0]!.text).not.toContain('Generated instruction');
  });
  it.each(['queued', 'tool'] as const)('cancels persisted obsolete periodic %s rows even with the old setting enabled', async state => {
    binding.activeTurnId = 'turn-one'; binding.impulseMinutes = 3;
    const row: InputEntry = { ...input(), state, owner: state === 'tool' ? 'old-request' : null,
      createdAt: now, conversationId: binding.conversationId,
      ...(state === 'tool' ? { offeredAt: now } : {}), finishOwner: { turnId: 'turn-one', periodic: true } };
    await writeDurableNow('session-input', [row]); resetInputForTests();
    expect(await offerToolInput(sessionId, binding.conversationId, 'later-request', now + 1, true)).toEqual([]);
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    expect(await pendingBrowserInputs()).toEqual([]);
    await expect(enqueueInput(input(), { turnId: 'turn-one', periodic: true })).rejects.toThrow('no longer belongs');
  });
  it.each(['end', 'next-turn', 'hold-off'] as const)('does not deliver a queued finish instruction after %s, including restart', async change => {
    binding.activeTurnId = 'turn-one';
    const row = await enqueueInput(input({ text: 'Check the remaining issue' }), { turnId: 'turn-one', periodic: false });
    if (change === 'end') binding.finishReleased = true;
    if (change === 'next-turn') binding.activeTurnId = 'turn-two';
    if (change === 'hold-off') binding.finishEnabled = false;
    resetInputForTests();
    expect(await offerToolInput(sessionId, binding.conversationId, 'new-request', now + 1)).toEqual([]);
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('cancelled');
    expect(await pendingBrowserInputs()).toEqual([]);
  });  it('delivers a generated finish instruction through the existing exact tool receipt once', async () => {
    binding.activeTurnId = 'turn-one';
    const row = await enqueueInput(input({ text: 'Finish the validation' }), { turnId: 'turn-one', periodic: false });
    expect(await offerToolInput(sessionId, binding.conversationId, 'first-request', now + 1, true)).toHaveLength(1);
    now += 100;
    expect(await offerToolInput(sessionId, binding.conversationId, 'next-request', now, true)).toEqual([]);
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('sent');
  });
  it('offers and claims an ordinary follow-up after the recorded turn already completed', async () => {
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'completed-greeting', time: now };
    now += 69000;
    const row = await enqueueInput(input({ text: 'Read one file', dueAt: now }));
    // offeredAt is claim metadata, not proof that /status has published the offer.
    expect(row.offeredAt).toBeUndefined();
    expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: binding.conversationId }]);
    const claim = await claimBrowserInput(row.id, 'exact-browser-document', binding.conversationId, true);
    expect(claim).toMatchObject({ state: 'browser', owner: 'exact-browser-document', offeredAt: now });
  });

  it('persists reordered finish tasks and uses that order at the tool boundary', async () => {
    const a = await enqueueInput(input({ mode: 'finish', text: 'A' }));
    const b = await enqueueInput(input({ mode: 'finish', text: 'B' }));
    expect(await reorderQueuedInputs(sessionId, [b.id, a.id])).toBe(true);
    resetInputForTests();
    expect((await listInputs()).map(row => row.text)).toEqual(['B', 'A']);
    await enqueueInput(input({ mode: 'finish', text: 'C' }));
    expect((await listInputs()).map(row => row.text)).toEqual(['B', 'A', 'C']);
    const delivered = await offerToolInput(sessionId, binding.conversationId, 'request', now, true);
    expect(delivered.map(row => row.text).join(' ')).toContain('B');
    expect(delivered.map(row => row.text).join(' ')).not.toContain('A');
    expect(await reorderQueuedInputs(sessionId, [a.id, b.id])).toBe(false);
  });
  it('rejects stale, duplicate and cross-session reorder snapshots without altering the queue', async () => {
    const a = await enqueueInput(input({ mode: 'finish', text: 'A' }));
    const b = await enqueueInput(input({ mode: 'finish', text: 'B' }));
    expect(await reorderQueuedInputs(sessionId, [a.id])).toBe(false);
    expect(await reorderQueuedInputs(sessionId, [a.id, a.id])).toBe(false);
    expect(await reorderQueuedInputs('other-session', [b.id, a.id])).toBe(false);
    expect((await listInputs()).map(row => row.id)).toEqual([a.id, b.id]);
  });
  it('stamps only proven desktop-created chats and restores that origin from the retained receipt', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'page', null);
    expect(noteChatOrigin).not.toHaveBeenCalled();
    await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'native-user');
    expect(noteChatOrigin).toHaveBeenCalledWith(binding.conversationId, { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
    vi.mocked(noteChatOrigin).mockClear();
    resetInputForTests(); await listInputs();
    expect(noteChatOrigin).toHaveBeenCalledWith(binding.conversationId, expect.objectContaining({ kind: 'desktop' }));
    vi.mocked(noteChatOrigin).mockClear();
    const existing = await enqueueInput(input());
    await claimBrowserInput(existing.id, 'existing', binding.conversationId);
    await acknowledgeBrowserInput(existing.id, 'existing', binding.conversationId, 'followup');
    expect(noteChatOrigin).not.toHaveBeenCalled();
  });
  it('retries preparation through existing offers but grants native Send only once to the current owner', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'lost-response-page', null, true);
    expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: null }]);
    expect(await claimBrowserInput(row.id, 'replacement-page', null, true)).toMatchObject({ id: row.id, owner: 'replacement-page' });
    expect(await authorizeBrowserInput(row.id, 'lost-response-page', null)).toBe(false);
    expect(await authorizeBrowserInput(row.id, 'replacement-page', null)).toBe(true);
    expect(await authorizeBrowserInput(row.id, 'replacement-page', null)).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'late-page', null, true)).toBeNull();
    now += 45000;
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', error: expect.stringContaining('may already') });
    await expect(enqueueInput(input())).resolves.toMatchObject({ state: 'queued' });
    expect(await acknowledgeBrowserInput(row.id, 'replacement-page', binding.conversationId, 'late-native')).toBe(true);
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', messageId: 'late-native' });
  });
  it('does not replay a retained transcript just to restore an origin already present in the catalog', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'page', null);
    await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'native-user');
    vi.mocked(noteChatOrigin).mockClear();
    vi.mocked(listUsageSessions).mockResolvedValueOnce([{ id: sessionId, conversationId: binding.conversationId, origin: { kind: 'desktop' } }] as never);
    resetInputForTests(); await listInputs();
    expect(noteChatOrigin).not.toHaveBeenCalled();
    // Two current records are not one proven stamped origin; preserve ordinary repair.
    vi.mocked(listUsageSessions).mockResolvedValueOnce([{ id: sessionId, conversationId: binding.conversationId, origin: { kind: 'desktop' } }, { id: 'session-two', conversationId: binding.conversationId, origin: null }] as never);
    resetInputForTests(); await listInputs();
    expect(noteChatOrigin).toHaveBeenCalledWith(binding.conversationId, expect.objectContaining({ kind: 'desktop' }));
  });
  it('expires pre-send preparation without images within one minute and revokes a late document', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'page', null, true);
    now += 60000;
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', error: expect.stringContaining('Not sent') });
    expect(await authorizeBrowserInput(row.id, 'page', null)).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
    await expect(enqueueInput(input())).resolves.toMatchObject({ state: 'queued' });
  });
  it('keeps temporary planner text and answer out of durable storage and accepts an exact id-less receipt', async () => {
    const controller = new AbortController();
    const wake = vi.fn(async () => undefined);
    configureInputDelivery({ applyAutomation: automate, changed, wakeDecision: wake });
    const answer = requestBrowserDecision('PRIVATE PLANNER TASK', controller.signal, { lifetime: 'temporary-planner' });
    await vi.waitFor(async () => expect(await pendingBrowserInputs()).toHaveLength(1));
    const row = (await listInputs())[0]!;
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith(expect.objectContaining({ id: row.id, lifetime: 'temporary-planner', conversationId: null }), controller.signal));
    expect(await claimBrowserInput(row.id, 'temporary-page', null)).toMatchObject({ text: 'PRIVATE PLANNER TASK', lifetime: 'temporary-planner' });
    expect(await acknowledgeBrowserInput(row.id, 'temporary-page', null)).toBe(true);
    expect(await completeBrowserDecision(row.id, 'wrong-page', 'PRIVATE RESPONSE', null)).toBe(false);
    expect(await completeBrowserDecision(row.id, 'temporary-page', 'PRIVATE RESPONSE', null)).toBe(true);
    expect(await answer).toBe('PRIVATE RESPONSE');
    const durable = JSON.stringify(await readDurable('session-input'));
    expect(durable).not.toContain('PRIVATE');
    expect(durable).toContain('temporary-planner');
  });
  it('persists fresh-chat Off before ACK and applies Off after ACK without resending', async () => {
    const entry = await enqueueInput(input({ sessionId: null, automation: 'goal', objective: 'Keep objective' }));
    await claimBrowserInput(entry.id, 'browser-owner', null);
    expect(await setInputAutomation(entry.id, 'off')).toBe(true);
    expect(await acknowledgeBrowserInput(entry.id, 'browser-owner', binding.conversationId)).toBe(true);
    expect(automate.mock.calls.map(call => call[1])).toEqual(['off']);
    expect((await listInputs()).find(row => row.id === entry.id)).toMatchObject({ state: 'sent', automation: 'off', objective: 'Keep objective' });
    await acknowledgeBrowserInput(entry.id, 'browser-owner', binding.conversationId);
    expect(automate).toHaveBeenCalledTimes(1);
    const second = await enqueueInput(input({ sessionId: null, automation: 'goal' }));
    await claimBrowserInput(second.id, 'second-owner', null);
    await acknowledgeBrowserInput(second.id, 'second-owner', binding.conversationId);
    expect(await setInputAutomation(second.id, 'off')).toBe(true);
    expect(automate.mock.calls.at(-1)?.[1]).toBe('off');
    await acknowledgeBrowserInput(second.id, 'second-owner', binding.conversationId);
    expect(automate.mock.calls.at(-1)?.[1]).toBe('off');
  });
  it('expires a legacy initial browser attempt while retaining an intentional after-turn wait', async () => {
    const stale = await seedLegacyInput(input({ sessionId: null }));
    const after = await seedLegacyInput(input({ mode: 'after-turn' }));
    now += 600001;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'fresh-end', time: now };
    expect(await pendingBrowserInputs()).toContainEqual({ id: after.id, conversationId: binding.conversationId });
    expect((await listInputs()).find(row => row.id === stale.id)).toMatchObject({ state: 'failed' });
    resetInputForTests();
    expect(await claimBrowserInput(stale.id, 'after-restart', null)).toBeNull();
  });
  it('waits indefinitely for tool injection after restart', async () => {
    binding.activeTurnId = 'active';
    const row = await enqueueInput(input());
    binding.activeTurnId = null;
    now += 365 * 24 * 60 * 60 * 1000;
    resetInputForTests();
    expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'queued' });
    expect((await offerToolInput(sessionId, binding.conversationId, 'late-tool', now))[0]?.text).toContain(row.text);
  });
  it('lets the user cancel indefinitely queued input after restart', async () => {
    binding.activeTurnId = 'active';
    const row = await enqueueInput(input());
    now += 365 * 24 * 60 * 60 * 1000;
    resetInputForTests();
    expect(await cancelInput(row.id)).toBe(true);
    resetInputForTests();
    expect(await offerToolInput(sessionId, binding.conversationId, 'next-tool', now + 1)).toEqual([]);
  });
  it('bounds pending user messages across chats while allowing an exact UUID retry', async () => {
    const first = input({ sessionId: null });
    await enqueueInput(first);
    expect(await enqueueInput(first)).toMatchObject({ id: first.id });
    await expect(enqueueInput(input())).rejects.toThrow('One message');
    expect(await cancelInput(first.id)).toBe(true);
    await expect(enqueueInput(input())).resolves.toMatchObject({ state: 'queued' });
  });
  it.each(['tool', 'browser'] as const)('retains the %s delivery receipt when recording fails and never resends it', async (transport) => {
    const record = vi.fn(async () => { throw new Error('recorder unavailable'); return true; });
    configureInputDelivery({ applyAutomation: automate, changed, recordDelivered: record });
    const row = await enqueueInput(input());
    if (transport === 'tool') {
      expect(await offerToolInput(sessionId, binding.conversationId, 'same-request', 0)).toHaveLength(1);
      now++;
      expect(await offerToolInput(sessionId, binding.conversationId, 'same-request', now)).toEqual([]);
    } else {
      expect(await claimBrowserInput(row.id, 'page', binding.conversationId)).not.toBeNull();
      expect(await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'native-message')).toBe(true);
    }
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', messageId: transport === 'tool' ? `input:${row.id}` : 'native-message' });
    expect((await listInputs())[0]?.historyRecorded).not.toBe(true);
    resetInputForTests(); // receipt persists across restart, unlike in-flight timing proof
    expect(await offerToolInput(sessionId, binding.conversationId, 'next', ++now)).toEqual([]);
    expect(await claimBrowserInput(row.id, 'another-page', binding.conversationId)).toBeNull();
    record.mockResolvedValue(true);
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', historyRecorded: true });
    const calls = record.mock.calls.length;
    await listInputs();
    expect(record).toHaveBeenCalledTimes(calls);
  });
  it('reprojects a wrapped recorded receipt after restart without reopening delivery', async () => {
    const record = vi.fn(async (_entry: InputEntry) => true);
    configureInputDelivery({ applyAutomation: automate, changed, recordDelivered: record });
    const args = input({ text: 'hello' });
    const receipt: InputEntry = { ...args, state: 'sent', owner: null, createdAt: now,
      conversationId: binding.conversationId, deliveryText: 'hello\n\nInternal instructions',
      deliveredAt: now, messageId: 'native-message', historyRecorded: true };
    await writeDurableNow('session-input', [receipt]);
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ state: 'sent', historyRecorded: true });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ text: 'hello', deliveryText: receipt.deliveryText, messageId: 'native-message' });
    expect(await claimBrowserInput(receipt.id, 'another-page', binding.conversationId)).toBeNull();
    expect(await offerToolInput(sessionId, binding.conversationId, 'next', ++now)).toEqual([]);
    await listInputs();
    expect(record).toHaveBeenCalledTimes(1);
  });
  it('legacy queue: offers images in the held turn, bounds each offer to four, and preserves the receipt boundary', async () => {
    binding.activeTurnId = 'held-turn';
    const images = Array.from({ length: 4 }, (_, index) => ({ name: `${index}.webp`, dataUrl: 'data:image/webp;base64,YQ==' }));
    const first = await seedLegacyInput(input({ images }));
    await seedLegacyInput(input({ images: images.slice(0, 1) }));
    expect(await hasEligibleToolInput(sessionId)).toBe(true);
    expect(await claimBrowserInput(first.id, 'page', binding.conversationId)).toBeNull();
    const offered = await offerToolInput(sessionId, binding.conversationId, 'turn-id', 0);
    expect(offered).toHaveLength(1);
    expect(offered[0]?.images).toEqual(images);
    expect(await offerToolInput(sessionId, binding.conversationId, 'turn-id', 0)).toEqual(offered);
    now += 1;
    const next = await offerToolInput(sessionId, binding.conversationId, 'turn-id', now);
    expect(next).toHaveLength(1);
    expect(next[0]?.images).toHaveLength(1);
    expect((await listInputs()).find(row => row.id === first.id)?.state).toBe('sent');
  });
  it('keeps input in tool delivery during a proven active turn even when the browser looks idle', async () => {
    binding.activeTurnId = 'real-turn';
    const row = await enqueueInput(input());
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'idle-looking-document', binding.conversationId)).toBeNull();
    expect(await offerToolInput(sessionId, binding.conversationId, 'next-tool', 0)).toHaveLength(1);
    await offerToolInput(sessionId, binding.conversationId, 'ack-tool', now + 1);
    const after = await enqueueInput(input({ mode: 'after-turn', afterTurn: true }));
    expect(await claimBrowserInput(after.id, 'idle-looking-document', binding.conversationId)).toBeNull();
    binding.activeTurnId = null;
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'real-turn', time: now + 1 };
    await offerToolInput(sessionId, binding.conversationId, 'ack', now + 1);
    expect((await pendingBrowserInputs()).some(entry => entry.id === after.id)).toBe(true);
  });
  it('applies scheduled automation only at handout and never replays it on ACK', async () => {
    const row = await enqueueInput(input({ automation: 'loop', dueAt: 2000 }));
    expect(automate).not.toHaveBeenCalled();
    expect(await claimBrowserInput(row.id, 'owner', binding.conversationId)).toBeNull();
    expect(await offerToolInput(sessionId, binding.conversationId, 'early', 0)).toEqual([]);
    expect(automate).not.toHaveBeenCalled();
    now = 2000;
    await claimBrowserInput(row.id, 'owner', binding.conversationId);
    expect(automate).toHaveBeenCalledExactlyOnceWith(binding.conversationId, 'loop', 'before-send', undefined);
    await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId);
    await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId);
    expect(automate).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalled();
  });
  it('applies tool input automation before disclosure and never repeats on overlapping offers', async () => {
    await enqueueInput(input({ automation: 'off' }));
    expect(await offerToolInput(sessionId, binding.conversationId, 'first', 0)).toHaveLength(1);
    expect(automate).toHaveBeenCalledExactlyOnceWith(binding.conversationId, 'off', 'before-send', undefined);
    expect(await offerToolInput(sessionId, binding.conversationId, 'overlapping', 0)).toHaveLength(1);
    expect(automate).toHaveBeenCalledTimes(1);
  });
  it('does not retry an interrupted automation attempt after restart or late ACK', async () => {
    const row = await enqueueInput(input({ automation: 'goal' }));
    automate.mockRejectedValueOnce(new Error('settings persistence failed'));
    await expect(claimBrowserInput(row.id, 'owner', binding.conversationId)).rejects.toThrow('settings persistence failed');
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('not sent') });
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'owner', binding.conversationId)).toBeNull();
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId)).toBe(false);
    expect(await offerToolInput(sessionId, binding.conversationId, 'later', 2001)).toEqual([]);
    expect(automate).toHaveBeenCalledTimes(1);
  });
  it('keeps a spent automation attempt inert if the final delivery commit fails', async () => {
    const row = await enqueueInput(input({ automation: 'goal' }));
    automate.mockImplementationOnce(async () => {
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('final commit failed'));
    });
    await expect(claimBrowserInput(row.id, 'owner', binding.conversationId)).rejects.toThrow('final commit failed');
    await flushDurable();
    resetInputForTests();
    expect((await listInputs())[0]?.state).toBe('failed');
    expect(await claimBrowserInput(row.id, 'owner', binding.conversationId)).toBeNull();
    expect(automate).toHaveBeenCalledTimes(1);
  });
  it('binds a fresh send to its exact conversation and recording without changing authored identity', async () => {
    const args = input({ sessionId: null, automation: 'goal', objective: 'Build the requested project and test it' });
    const row = await enqueueInput(args);
    expect(await claimBrowserInput(row.id, 'owner', null)).toMatchObject({ automation: 'goal' });
    expect(await acknowledgeBrowserInput(row.id, 'owner')).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'other', binding.conversationId)).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId)).toBe(true);
    expect(automate).toHaveBeenCalledExactlyOnceWith(binding.conversationId, 'goal', 'after-send', 'Build the requested project and test it');
    expect((await listInputs())[0]).toMatchObject({ sessionId: null, deliveredSessionId: sessionId, conversationId: binding.conversationId, state: 'sent' });
    expect(await enqueueInput(args)).toMatchObject({ state: 'sent', automation: 'goal' });
    expect(await acknowledgeBrowserInput(row.id, 'owner', 'conversation-other')).toBe(false);
    expect(automate).toHaveBeenCalledTimes(1);
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ deliveredSessionId: sessionId, objective: 'Build the requested project and test it' });
  });
  it('waits for exact recording evidence when a new send ACK precedes recorder creation', async () => {
    binding.recorded = false;
    const row = await enqueueInput(input({ sessionId: null, automation: 'loop' }));
    await claimBrowserInput(row.id, 'owner', null);
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId)).toBe(true);
    expect((await listInputs())[0]?.deliveredSessionId).toBeNull();
    binding.recorded = true;
  binding.activeTurnId = null;
    expect((await listInputs())[0]?.deliveredSessionId).toBe(sessionId);
    binding.conversationId = 'conversation-resumed';
    expect((await listInputs())[0]?.deliveredSessionId).toBe(sessionId);
  });
  it('deduplicates exact ids, rejects changed input, and returns detached rows', async () => {
    const args = input();
    const row = await enqueueInput(args);
    row.text = 'mutated';
    expect((await enqueueInput(args)).text).toBe(args.text);
    await expect(enqueueInput({ ...args, text: 'changed' })).rejects.toThrow('different input');
    expect(await listInputs()).toHaveLength(1);
  });
  it('uses the durable session current binding after resume and refuses retired callers', async () => {
    const row = await enqueueInput(input());
    binding.conversationId = 'conversation-b';
    expect(await offerToolInput(sessionId, 'conversation-a', 'old', 0)).toEqual([]);
    expect(await claimBrowserInput(row.id, 'page-a', 'conversation-a')).toBeNull();
    expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: 'conversation-b', supersededConversationId: 'conversation-a' }]);
    expect(await claimBrowserInput(row.id, 'page-b', 'conversation-b')).toMatchObject({ state: 'browser' });
  });
  it('legacy queue: elects one browser owner and excludes tools for that session', async () => {
    const row = await seedLegacyInput(input());
    const claims = await Promise.all(['one', 'two'].map(owner => claimBrowserInput(row.id, owner, binding.conversationId)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await seedLegacyInput(input());
    expect(await offerToolInput(sessionId, binding.conversationId, 'request', 0)).toEqual([]);
    expect(await acknowledgeBrowserInput(row.id, 'two')).toBe(false);
    expect(await acknowledgeBrowserInput(row.id, 'one')).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'one')).toBe(true);
  });
  it('legacy queue: allows independent new-chat inputs to claim separately', async () => {
    const a = await seedLegacyInput(input({ sessionId: null }));
    const b = await seedLegacyInput(input({ sessionId: null }));
    expect(await claimBrowserInput(a.id, 'a', null)).not.toBeNull();
    expect(await claimBrowserInput(b.id, 'b', null)).not.toBeNull();
  });
  it('legacy queue: preserves insertion order for messages sharing the same scheduled millisecond', async () => {
    const a = await seedLegacyInput(input());
    const b = await seedLegacyInput(input());
    expect(await claimBrowserInput(b.id, 'page', binding.conversationId)).toBeNull();
    expect(await claimBrowserInput(a.id, 'page', binding.conversationId)).not.toBeNull();
    await acknowledgeBrowserInput(a.id, 'page');
    expect(await claimBrowserInput(b.id, 'page', binding.conversationId)).not.toBeNull();
  });
  it('does not acknowledge a message from an overlapping request, including slow commit', async () => {
    const row = await enqueueInput(input());
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      now = 2000;
      await realRename(from, to);
    });
    expect(await offerToolInput(sessionId, binding.conversationId, 'first', 500)).toHaveLength(1);
    expect(await offerToolInput(sessionId, binding.conversationId, 'parallel', 1500)).toHaveLength(1);
    expect((await listInputs())[0]?.state).toBe('tool');
    expect(await claimBrowserInput(row.id, 'browser', binding.conversationId)).toBeNull();
    expect(await offerToolInput(sessionId, binding.conversationId, 'later', 2001)).toEqual([]);
    expect((await listInputs())[0]?.state).toBe('sent');
  });
  it('legacy queue: acknowledges a later invocation with the same server-turn request id and unblocks after-turn input', async () => {
    const row = await seedLegacyInput(input());
    const after = await seedLegacyInput(input({ mode: 'after-turn' }));
    const first = await offerToolInput(sessionId, binding.conversationId, 'same-server-turn', 500);
    expect(first[0]?.text).toBe(row.text);
    expect(await offerToolInput(sessionId, binding.conversationId, 'same-server-turn', 500)).toEqual(first);
    expect(await offerToolInput(sessionId, binding.conversationId, 'same-server-turn', now)).toEqual(first);
    now += 1;
    expect(await offerToolInput(sessionId, binding.conversationId, 'same-server-turn', now)).toEqual([]);
    expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('sent');
    binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'fresh-end', time: now };
    expect(await claimBrowserInput(after.id, 'after-turn-page', binding.conversationId)).toMatchObject({ id: after.id });
  });
  it('reoffers the same input after restart, retaining its internal id rather than treating old timestamps as receipt', async () => {
    const row = await enqueueInput(input());
    await offerToolInput(sessionId, binding.conversationId, 'first', 0);
    resetInputForTests();
    now = 5000;
    expect((await offerToolInput(sessionId, binding.conversationId, 'after-restart', 4000))[0]?.text).toBe(row.text);
    expect((await listInputs())[0]).toMatchObject({ id: row.id, state: 'tool' });
  });
  it('honors due times without letting an after-turn wait block immediate tool input', async () => {
    const later = await seedLegacyInput(input({ dueAt: 2000 }));
    const after = await seedLegacyInput(input({ mode: 'after-turn', dueAt: 500 }));
    const auto = await seedLegacyInput(input({ dueAt: 600 }));
    expect((await pendingBrowserInputs()).map(row => row.id)).toEqual([auto.id]);
    expect(await hasEligibleToolInput(sessionId)).toBe(true);
    expect((await offerToolInput(sessionId, binding.conversationId, 'request', 0)).map(row => row.text)).toEqual([auto.text]);
    expect(await pendingBrowserInputs()).not.toContainEqual({ id: after.id, conversationId: binding.conversationId });
    expect(await claimBrowserInput(later.id, 'page', binding.conversationId)).toBeNull();
    expect((await listInputs()).find(row => row.id === after.id)?.state).toBe('queued');
    expect((await listInputs()).find(row => row.id === later.id)?.state).toBe('queued');
  });
  it('injects explicit tool messages behind an after-turn task and retains that task across restart', async () => {
    binding.model = 'gpt-5-6-pro'; binding.activeTurnId = 'active-pro-turn';
    const after = await enqueueInput(input({ mode: 'after-turn', text: 'After the answer' }));
    const first = await enqueueInput(input({ mode: 'auto', text: 'Immediate first' }));
    const second = await enqueueInput(input({ mode: 'auto', text: 'Immediate second' }));
    expect(first.transportIntent).toBe('tool'); expect(second.transportIntent).toBe('tool');
    resetInputForTests();
    expect(await hasEligibleToolInput(sessionId)).toBe(true);
    expect(await offerToolInput(sessionId, 'wrong-conversation', 'request', now)).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'request', now)).toEqual([
      { text: first.text, images: [] }, { text: second.text, images: [] }
    ]);
    now += 1;
    await acknowledgeToolInput(sessionId, binding.conversationId, 'request', now);
    expect(await hasEligibleToolInput(sessionId)).toBe(false);
    expect((await listInputs()).map(row => ({ id: row.id, state: row.state }))).toEqual([
      { id: after.id, state: 'queued' }, { id: first.id, state: 'sent' }, { id: second.id, state: 'sent' }
    ]);
  });
  it('keeps claimed browser input inert across restart and bounds failure text', async () => {
    const row = await enqueueInput(input());
    await claimBrowserInput(row.id, 'owner', binding.conversationId);
    resetInputForTests();
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await failBrowserInput(row.id, 'other', 'failure')).toBe(false);
    expect(await failBrowserInput(row.id, 'owner', 'x'.repeat(500))).toBe(true);
    expect((await listInputs())[0]?.error).toHaveLength(200);
  });
  it('legacy queue: releases all three orphan browser claims on explicit cancellation without replay after restart', async () => {
    const rows = [];
    for (let index = 0; index < 3; index++) {
      const row = await seedLegacyInput(input({ sessionId: null }));
      await claimBrowserInput(row.id, `old-page-${index}`, null);
      rows.push(row);
    }
    resetInputForTests();
    await expect(enqueueInput(input({ sessionId: null }))).rejects.toThrow('One message');
    for (const row of rows) expect(await cancelInput(row.id)).toBe(true);
    resetInputForTests();
    expect(await pendingBrowserInputs()).toEqual([]);
    await expect(enqueueInput(input({ sessionId: null }))).resolves.toMatchObject({ state: 'queued' });
  });
  it('reports confirmed non-delivery when cancelled before the browser receives Send authority', async () => {
    const row = await enqueueInput(input({ sessionId: null }));
    await claimBrowserInput(row.id, 'owner', null, true);
    expect(await cancelInput(row.id)).toBe(true);
    resetInputForTests();
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', error: expect.stringContaining('Not sent:') });
    expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
    await expect(enqueueInput(input({ sessionId: null }))).resolves.toMatchObject({ state: 'queued' });
  });
  it('cancels an ambiguous browser claim across restart and retains a late receipt without automation or stages', async () => {
    const row = await enqueueInput(input({ sessionId: null, automation: 'goal', stages: ['Later task'] }));
    await claimBrowserInput(row.id, 'owner', null);
    expect(await authorizeBrowserInput(row.id, 'other', null)).toBe(false);
    expect(await authorizeBrowserInput(row.id, 'owner', 'wrong-conversation')).toBe(false);
    expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(true);
    resetInputForTests();
    expect(await cancelInput(row.id)).toBe(true);
    expect(await authorizeBrowserInput(row.id, 'owner', null)).toBe(false);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'owner', null)).toBeNull();
    expect(await acknowledgeBrowserInput(row.id, 'other', binding.conversationId, 'native-id')).toBe(false);
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', error: expect.stringContaining('may already') });
    expect(await acknowledgeBrowserInput(row.id, 'owner', binding.conversationId, 'native-id')).toBe(true);
    expect(automate).not.toHaveBeenCalled();
    resetInputForTests();
    const rows = await listInputs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'cancelled', messageId: 'native-id', error: expect.stringContaining('later confirmed') });
    expect(await enqueueInput(input({ ...row }))).toMatchObject({ state: 'cancelled' });
    expect(await cancelInput(row.id)).toBe(false);
  });
  it('does not publish a rejected enqueue through a background durable retry', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk busy'));
    await expect(enqueueInput(input())).rejects.toThrow('disk busy');
    await flushDurable();
    expect(await readDurable('session-input')).toEqual([]);
    expect(await listInputs()).toEqual([]);
  });
  it('does not disclose input when durable claim fails and leaves it claimable', async () => {
    const row = await enqueueInput(input());
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk busy'));
    await expect(claimBrowserInput(row.id, 'first', binding.conversationId)).rejects.toThrow('disk busy');
    await flushDurable();
    resetInputForTests();
    expect(await claimBrowserInput(row.id, 'second', binding.conversationId)).toMatchObject({ owner: 'second' });
  });
  it('legacy queue: refuses blocked or unidentified callers and caps aggregate tool output', async () => {
    configureInputDelivery({ applyAutomation: automate, changed, prepareText: entry => entry.text.repeat(2) });
    for (let i = 0; i < 3; i++) await seedLegacyInput(input({ text: 'é'.repeat(16000) }));
    await expect(enqueueInput(input())).rejects.toThrow('One message');
    expect(await offerToolInput(null, binding.conversationId, 'request', 0)).toEqual([]);
    binding.blocked = true;
    expect(await offerToolInput(sessionId, binding.conversationId, 'request', 0)).toEqual([]);
    binding.blocked = false;
    const result = await offerToolInput(sessionId, binding.conversationId, 'request', 0);
    expect(result.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(result.map(row => row.text).join(''))).toBeLessThanOrEqual(128000);
    expect((await listInputs()).some(row => row.state === 'queued')).toBe(true);
  });
});

describe('browser decision lifetime', () => {
  it('does not redeem a fresh scheduled marker before its due time', async () => {
    const entry = await enqueueInput(input({ sessionId: null, dueAt: now + 60000 }));
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(entry.id, 'fresh-marker-document', null)).toBeNull();
    now += 60000;
    expect(await pendingBrowserInputs()).toEqual([{ id: entry.id, conversationId: null }]);
    expect(await claimBrowserInput(entry.id, 'fresh-marker-document', null)).toMatchObject({ id: entry.id, state: 'browser' });
  });
  it('requires a deliberate exact-source retry and never revives the previous owner', async () => {
    const controller = new AbortController();
    const first = requestBrowserDecision('Choose', controller.signal, { sourceSessionId: sessionId });
    const rejected = expect(first).rejects.toThrow('cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'old-document', null);
    controller.abort(); await rejected;
    expect(await pausedBrowserHelpers()).toEqual([{ id: row.id, sourceSessionId: sessionId }]);
    expect(await authorizeBrowserHelperRetry(row.id, 'wrong-source')).toBe(false);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk busy'));
    await expect(authorizeBrowserHelperRetry(row.id, sessionId)).rejects.toThrow('disk busy');
    await flushDurable();
    expect(await pausedBrowserHelpers()).toHaveLength(1);
    expect(await authorizeBrowserHelperRetry(row.id, sessionId)).toBe(true);
    expect(await authorizeBrowserHelperRetry(row.id, sessionId)).toBe(false);
    expect(await completeBrowserDecision(row.id, 'old-document', 'late')).toBe(false);
    expect(await pausedBrowserHelpers()).toEqual([]);
    const second = requestBrowserDecision('Choose again', new AbortController().signal, { sourceSessionId: sessionId });
    const next = (await listInputs()).find(entry => entry.state === 'queued')!;
    expect(next.id).not.toBe(row.id);
    await claimBrowserInput(next.id, 'new-document', null);
    expect(await completeBrowserDecision(next.id, 'new-document', 'accepted', 'helper-new-chat')).toBe(true);
    await expect(second).resolves.toBe('accepted');
  });
  it('reuses the exact helper target and keeps source input out of its queue', async () => {
    binding.activeTurnId = 'source-still-running';
    const controller = new AbortController();
    const answer = requestBrowserDecision('New source response', controller.signal, {
      sourceSessionId: sessionId, conversationId: 'helper-conversation', model: 'gpt-5.6-sol', reasoningEffort: 'high'
    });
    const row = (await listInputs())[0]!;
    expect(row).toMatchObject({ sessionId: null, decisionSourceSessionId: sessionId, model: 'gpt-5.6-sol', reasoningEffort: 'high' });
    expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: 'helper-conversation' }]);
    expect(await claimBrowserInput(row.id, 'wrong', binding.conversationId)).toBeNull();
    expect(await claimBrowserInput(row.id, 'helper', 'helper-conversation')).not.toBeNull();
    expect(await completeBrowserDecision(row.id, 'helper', 'reply', binding.conversationId)).toBe(false);
    expect(await completeBrowserDecision(row.id, 'helper', 'reply', 'helper-conversation')).toBe(true);
    await expect(answer).resolves.toBe('reply');
  });
  it('blocks duplicate source helpers and new tabs after an ambiguous fresh cancellation', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose', controller.signal, { sourceSessionId: sessionId });
    const rejected = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    await expect(requestBrowserDecision('Again', new AbortController().signal, { sourceSessionId: sessionId })).rejects.toThrow('goal_browser_busy');
    await claimBrowserInput(row.id, 'document', null);
    controller.abort();
    await rejected;
    await expect(requestBrowserDecision('Retry', new AbortController().signal, { sourceSessionId: sessionId })).rejects.toThrow('goal_browser_send_unconfirmed');
    expect(await listInputs()).toHaveLength(1);
  });
  it('accepts only its exact claimant answer, with idempotent send ACK', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose one', controller.signal);
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'document', null);
    expect(await acknowledgeBrowserInput(row.id, 'document')).toBe(true);
    expect(await acknowledgeBrowserInput(row.id, 'document')).toBe(true);
    expect(await completeBrowserDecision(row.id, 'other', 'wrong')).toBe(false);
    expect(await completeBrowserDecision(row.id, 'document', 'accepted')).toBe(true);
    await expect(answer).resolves.toBe('accepted');
    expect(await completeBrowserDecision(row.id, 'document', 'accepted')).toBe(true);
    expect(await completeBrowserDecision(row.id, 'document', 'late')).toBe(false);
  });
  it('rejects a late answer immediately after cancellation', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose one', controller.signal);
    const rejection = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'document', null);
    controller.abort();
    expect(await completeBrowserDecision(row.id, 'document', 'late')).toBe(false);
    await rejection;
    expect((await listInputs())[0]?.state).toBe('cancelled');
  });
  it('rejects a pre-send failure without waiting for timeout', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose one', controller.signal);
    const rejection = expect(answer).rejects.toThrow('goal_browser_send_failed');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'document', null);
    await failBrowserInput(row.id, 'document', 'composer missing');
    await rejection;
    expect((await listInputs())[0]?.state).toBe('failed');
  });
  it('rejects cancellation that races a persisted answer', async () => {
    const controller = new AbortController();
    const answer = requestBrowserDecision('Choose one', controller.signal);
    const rejection = expect(answer).rejects.toThrow('goal_browser_cancelled');
    const row = (await listInputs())[0]!;
    await claimBrowserInput(row.id, 'document', null);
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      controller.abort();
      await realRename(from, to);
    });
    expect(await completeBrowserDecision(row.id, 'document', 'late')).toBe(false);
    await rejection;
    expect((await listInputs())[0]).toMatchObject({ state: 'cancelled', response: undefined });
  });
  it('handles cancellation during slow enqueue without leaking an unhandled rejection', async () => {
    const controller = new AbortController();
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      controller.abort();
      await realRename(from, to);
    });
    await expect(requestBrowserDecision('Choose one', controller.signal)).rejects.toThrow();
    expect((await listInputs())[0]?.state).toBe('cancelled');
    expect(await pendingBrowserInputs()).toEqual([]);
  });
  it('cancels orphan decisions on restart before advertising them', async () => {
    const row: InputEntry = { ...input({ sessionId: null }), purpose: 'decision', state: 'queued', owner: null, createdAt: 1, conversationId: null };
    await writeDurableNow('session-input', [row]);
    expect(await pendingBrowserInputs()).toEqual([]);
    expect((await listInputs())[0]?.state).toBe('cancelled');
    expect(await completeBrowserDecision(row.id, 'document', 'late')).toBe(false);
  });
});

it('delivers one finish task per boundary, keeps normal inputs unblocked, and permits edits only before handout', async () => {
  const first = await enqueueInput(input({ mode: 'finish', text: 'Stage one' }));
  const second = await enqueueInput(input({ mode: 'finish', text: 'Stage two' }));
  expect(await editQueuedInput(second.id, 'Stage two revised')).toBe(true);
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(first.id, 'browser', binding.conversationId)).toBeNull();
  expect(await offerToolInput(sessionId, binding.conversationId, 'ordinary', 0)).toEqual([]);
  expect(await hasEligibleToolInput(sessionId)).toBe(false);
  expect(await hasEligibleToolInput(sessionId, true)).toBe(true);
  const one = await offerToolInput(sessionId, binding.conversationId, 'finish', 0, true);
  expect(one).toHaveLength(1); expect(one[0]?.text).toContain('Stage one');
  expect(await editQueuedInput(first.id, 'Too late')).toBe(false);
  expect(await offerToolInput(sessionId, binding.conversationId, 'overlap', 0, true)).toEqual(one);
  expect((await listInputs()).find(row => row.id === second.id)?.state).toBe('queued');
  const two = await offerToolInput(sessionId, binding.conversationId, 'next-finish', now + 1, true);
  expect(two).toHaveLength(1); expect(two[0]?.text).toContain('Stage two revised');
  expect((await listInputs()).find(row => row.id === first.id)?.state).toBe('sent');
});

it('a queued finish task does not prevent a normal browser message from being claimed', async () => {
  await enqueueInput(input({ mode: 'finish' }));
  const ordinary = await enqueueInput(input());
  expect(await claimBrowserInput(ordinary.id, 'browser', binding.conversationId)).toMatchObject({ id: ordinary.id });
});

it.each(['finish', 'after-turn'] as const)('sends only one queued %s after each exact completed turn, including across restart', async mode => {
  binding.model = 'gpt-5.6-sol';
  binding.finishEnabled = false;
  const first = await enqueueInput(input({ mode, text: 'Second stage' }));
  const second = await enqueueInput(input({ mode, text: 'Third stage' }));
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'turn-one', time: now + 1 };
  expect(await pendingBrowserInputs()).toEqual([{ id: first.id, conversationId: binding.conversationId }]);
  await claimBrowserInput(first.id, 'page', binding.conversationId, true);
  await expect(enqueueInput(input())).rejects.toThrow('One message');
  await authorizeBrowserInput(first.id, 'page', binding.conversationId);
  expect(await pendingBrowserInputs()).toEqual([]);
  await acknowledgeBrowserInput(first.id, 'page', binding.conversationId, 'stage-user-one');
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(second.id, 'page', binding.conversationId, true)).toBeNull();
  binding.activeTurnId = 'turn-two';
  expect(await pendingBrowserInputs()).toEqual([]);
  binding.activeTurnId = null;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'turn-two', time: now + 2 };
  expect(await pendingBrowserInputs()).toEqual([{ id: second.id, conversationId: binding.conversationId }]);
});

it.each(['finish', 'after-turn'] as const)('does not advance %s on interruption, unknown outcome, error, or stale completion', async mode => {
  binding.model = 'gpt-5.6-sol';
  const row = await enqueueInput(input({ mode }));
  for (const outcome of ['interrupted', 'unknown', 'error', 'failed', 'stopped', 'stalled']) {
    binding.end = { kind: 'turn_end', outcome, turnId: 'turn-one', time: now + 1 };
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).toBeNull();
  }
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'old-turn', time: now - 1 };
  expect(await pendingBrowserInputs()).toEqual([]);
});

it.each(['finish', 'after-turn'] as const)('spends a settled Thinking failed once for ten queued %s messages across restart', async mode => {
  const rows = [];
  for (let n = 0; n < 10; n++) rows.push(await enqueueInput(input({ mode, afterTurn: true, text: `Checkpoint ${n}` })));
  binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-pro-turn', time: now + 1 };
  expect(await pendingBrowserInputs()).toEqual([{ id: rows[0]!.id, conversationId: binding.conversationId }]);
  expect(await claimBrowserInput(rows[1]!.id, 'page', binding.conversationId, true)).toBeNull();
  expect(await claimBrowserInput(rows[0]!.id, 'page', binding.conversationId, true)).not.toBeNull();
  expect(await authorizeBrowserInput(rows[0]!.id, 'page', binding.conversationId)).toBe(true);
  expect(await acknowledgeBrowserInput(rows[0]!.id, 'page', binding.conversationId, 'next-native-user')).toBe(true);
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect((await listInputs()).filter(row => row.state === 'queued')).toHaveLength(9);
  binding.end = { ...binding.end, turnId: 'next-failed-pro-turn', time: now + 2 };
  expect(await pendingBrowserInputs()).toEqual([{ id: rows[1]!.id, conversationId: binding.conversationId }]);
});

it.each(['late-tool', 'running-tool', 'new-turn', 'different-end', 'blocked'])('revokes a Thinking failed claim before Send after %s', async change => {
  const row = await enqueueInput(input({ mode: 'after-turn', afterTurn: true }));
  binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-pro-turn', time: now + 1 };
  expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
  if (change === 'late-tool') binding.lastToolCallAt = now + 2;
  if (change === 'new-turn') binding.activeTurnId = 'resumed-turn';
  if (change === 'different-end') binding.end = { ...binding.end, turnId: 'other-turn' };
  if (change === 'blocked') binding.blocked = true;
  if (change === 'running-tool') {
    await trackInFlight({ startedAt: now + 2, transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
      caller: { requestId: 'resumed-work', conversationId: binding.conversationId, transportKey: null } }, async () => {
      expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(false);
    });
  } else expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(false);
});

it('keeps Astra finish-only tasks queued after Thinking failed without explicit after-turn opt-in', async () => {
  await enqueueInput(input({ mode: 'finish' }));
  binding.end = { kind: 'turn_end', outcome: 'failed', reason: 'thinking_failed', turnId: 'failed-pro-turn', time: now + 1 };
  expect(await pendingBrowserInputs()).toEqual([]);
});

it('does not drain another stage while a finish-tool receipt is outstanding', async () => {
  await enqueueInput(input({ mode: 'finish' }));
  await enqueueInput(input({ mode: 'finish' }));
  await offerToolInput(sessionId, binding.conversationId, 'finish', 0, true);
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'turn-one', time: now + 1 };
  expect(await pendingBrowserInputs()).toEqual([]);
});
it('preserves more than 100 finish tasks through restart without consuming the one direct slot', async () => {
  const ids = [];
  for (let index = 0; index < 110; index++) ids.push((await enqueueInput(input({ mode: 'finish', text: `Stage ${index}` }))).id);
  resetInputForTests();
  expect((await listInputs()).filter(row => row.mode === 'finish').map(row => row.id)).toEqual(ids);
  const direct = await enqueueInput(input());
  await expect(enqueueInput(input())).rejects.toThrow('One message');
  await cancelInput(direct.id);
  resetInputForTests();
  expect((await listInputs()).filter(row => row.mode === 'finish')).toHaveLength(110);
});

it('replays an unacknowledged finish task after restart without draining the next stage', async () => {
  const first = await enqueueInput(input({ mode: 'finish', text: 'First stage' }));
  const second = await enqueueInput(input({ mode: 'finish', text: 'Second stage' }));
  const original = await offerToolInput(sessionId, binding.conversationId, 'finish', 0, true);
  resetInputForTests();
  const replay = await offerToolInput(sessionId, binding.conversationId, 'restart', now + 10, true);
  expect(replay).toEqual(original);
  expect((await listInputs()).find(row => row.id === second.id)?.state).toBe('queued');
  expect(await editQueuedInput(first.id, 'Cannot change claimed text')).toBe(false);
});

it('keeps future finish tasks after the normal send expiry', async () => {
  const row = await enqueueInput(input({ mode: 'finish' }));
  now += 60 * 60000;
  expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('queued');
});

it('rejects an oversized full plan before admission instead of silently starving tool delivery', async () => {
  const args = input({ text: '界'.repeat(16000), objective: 'Complete task', stages: Array.from({ length: 11 }, () => '界'.repeat(16000)) });
  await expect(enqueueInput(args)).rejects.toThrow('12,000');
  expect(await listInputs()).toEqual([]);
});
it('reports oversized legacy prepared tool input as failed without blocking later instructions', async () => {
  await seedLegacyInput(input({ text: '界'.repeat(16000), objective: 'Complete task', stages: Array.from({ length: 11 }, () => '界'.repeat(16000)) }));
  const next = await seedLegacyInput(input({ text: 'A deliverable instruction' }));
  const offered = await offerToolInput(sessionId, binding.conversationId, 'request', now);
  expect(offered).toHaveLength(1);
  expect(offered[0]?.text).toContain(next.text);
  expect((await listInputs())[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('delivery limit') });
});
it('accepts a full 16k original request and a workflow within the UI 12k limit', async () => {
  const row = await enqueueInput(input({ sessionId: null, objective: '界'.repeat(16000), text: '界'.repeat(5000), stages: ['界'.repeat(6900)] }));
  const claimed = await claimBrowserInput(row.id, 'page', null, true);
  expect(claimed?.deliveryText).toContain(row.objective);
  expect(Buffer.byteLength(claimed!.deliveryText!)).toBeLessThan(128000);
});
it('rejects an oversized restored plan before browser handout and leaves a visible failure', async () => {
  const row = await seedLegacyInput(input({ sessionId: null, text: '界'.repeat(16000), stages: Array.from({ length: 11 }, () => '界'.repeat(16000)) }));
  await expect(claimBrowserInput(row.id, 'page', null, true)).rejects.toThrow('delivery limit');
  expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'failed', owner: null, error: expect.stringContaining('delivery limit') });
  expect(await pendingBrowserInputs()).toEqual([]);
});
it.each(['goal', 'loop'] as const)('delivers the complete saved %s objective even when its generated opening omits constraints', async automation => {
  configureInputDelivery({ applyAutomation: automate, changed, prepareText: entry => entry.text + '\nHarness reminder' });
  const first = await enqueueInput(input({ sessionId: null, automation, objective: 'Report numbered arithmetic replies. Use no tools, files or workers.', text: 'LOOP_CEDAR_1' }));
  const claimed = await claimBrowserInput(first.id, 'page', null, true);
  expect(claimed?.deliveryText).toContain(first.objective);
  expect(claimed?.deliveryText).toContain(first.text);
  expect(claimed?.deliveryText).toContain('Harness reminder');
  expect((await listInputs()).find(row => row.id === first.id)?.text).toBe(first.text);
  resetInputForTests();
  expect((await listInputs()).find(row => row.id === first.id)?.deliveryText).toBe(claimed?.deliveryText);
});
it('delivers the original objective and complete workflow in the first plan message', async () => {
  configureInputDelivery({ applyAutomation: automate, changed, prepareText: entry => entry.text + '\nHarness reminder' });
  const first = await enqueueInput(input({ sessionId: null, objective: 'Build the whole requested application with two subagents.', text: 'Implement all requirements; delegate immediately.', stages: ['Exercise the app with computer use and fix failures.', 'Independent code review and final acceptance.'] }));
  const claimed = await claimBrowserInput(first.id, 'page', null, true);
  expect(claimed?.deliveryText).toContain(first.objective);
  for (const stage of [first.text, ...first.stages!]) expect(claimed?.deliveryText).toContain(stage);
  expect(claimed?.deliveryText).toContain('Harness reminder');
  expect((await listInputs()).find(row => row.id === first.id)?.text).toBe(first.text);
  resetInputForTests();
  expect((await listInputs()).find(row => row.id === first.id)?.deliveryText).toBe(claimed?.deliveryText);
});
it('durably queues all finish-plan stages immediately and keeps manual deletion and edits independent', async () => {
  const args = input({ mode: 'finish', text: 'First checkpoint', stages: ['Delete this checkpoint', 'Last checkpoint'] });
  const first = await enqueueInput(args);
  expect(first.stagesApplied).toBe(true);
  const initial = await listInputs();
  expect(initial.map(row => row.text)).toEqual([args.text, ...args.stages!]);
  expect(initial.every(row => row.state === 'queued' && row.mode === 'finish')).toBe(true);
  expect(await pendingBrowserInputs()).toEqual([]);
  resetInputForTests();
  await enqueueInput(args); // An admission retry must not duplicate the children.
  expect((await listInputs()).map(row => row.id)).toEqual(initial.map(row => row.id));
  await cancelInput(initial[1]!.id);
  await editQueuedInput(initial[2]!.id, 'Edited last checkpoint');
  const offered = await offerToolInput(sessionId, binding.conversationId, 'finish-first', now, true);
  expect(offered).toHaveLength(1);
  expect(offered[0]!.text).toBe('First checkpoint');
  now++;
  await acknowledgeToolInput(sessionId, binding.conversationId, 'next-request', now);
  resetInputForTests();
  const remaining = (await listInputs()).filter(row => row.state === 'queued');
  expect(remaining.map(row => row.text)).toEqual(['Edited last checkpoint']);
  expect((await listInputs()).filter(row => row.text === 'Delete this checkpoint')).toHaveLength(1);
});

it('materializes remaining plan stages once after exact delivery, across restart', async () => {
  const first = input({ sessionId: null, model: 'gpt-5.6-sol', reasoningEffort: 'high', stages: ['Implement remaining work', 'Verify acceptance'] });
  await enqueueInput(first);
  expect((await listInputs()).filter(row => row.mode === 'finish')).toHaveLength(0);
  await claimBrowserInput(first.id, 'plan-tab', null);
  await acknowledgeBrowserInput(first.id, 'plan-tab', binding.conversationId);
  resetInputForTests();
  const initial = (await listInputs()).filter(row => row.mode === 'finish');
  expect(initial.map(row => row.text)).toEqual(first.stages);
  expect(initial.every(row => row.sessionId === 'session-one')).toBe(true);
  expect(initial.every(row => row.model === null && row.reasoningEffort === null)).toBe(true);
  resetInputForTests();
  expect((await listInputs()).filter(row => row.mode === 'finish').map(row => row.id)).toEqual(initial.map(row => row.id));
  expect(await pendingBrowserInputs()).toEqual([]);
});

it('publishes browser decision partials only to the current exact waiter without completing it', async () => {
  const { publishBrowserDecision } = await import('../src/main/session/input.js');
  const abort = new AbortController(), publish = vi.fn();
  const answer = requestBrowserDecision('Exact helper question', abort.signal, { publish });
  await vi.waitFor(async () => expect(await listInputs()).toHaveLength(1));
  const entry = (await listInputs())[0]!;
  const claimed = await claimBrowserInput(entry.id, 'helper-owner', null);
  expect(claimed).not.toBeNull();
  await acknowledgeBrowserInput(entry.id, 'helper-owner', 'helper-conversation');
  expect(await publishBrowserDecision(entry.id, 'wrong-owner', 'helper-conversation', 'partial')).toBe(false);
  expect(await publishBrowserDecision(entry.id, 'helper-owner', 'other-conversation', 'partial')).toBe(false);
  expect(await publishBrowserDecision(entry.id, 'helper-owner', 'helper-conversation', 'x'.repeat(8001))).toBe(false);
  expect(await publishBrowserDecision(entry.id, 'helper-owner', 'helper-conversation', 'Actual partial')).toBe(true);
  expect(publish).toHaveBeenCalledExactlyOnceWith('Actual partial');
  abort.abort(); await expect(answer).rejects.toThrow('goal_browser_cancelled');
  expect(await publishBrowserDecision(entry.id, 'helper-owner', 'helper-conversation', 'late')).toBe(false);
});


it.each(REASONING_EFFORTS)('preserves canonical effort %s through validation and durable browser pickup', async reasoningEffort => {
  const args = inputArgs.parse(input({ model: 'observed-model', reasoningEffort }));
  const entry = await enqueueInput(args);
  await flushDurable();
  resetInputForTests();
  expect(await claimBrowserInput(entry.id, 'page', binding.conversationId)).toMatchObject({ model: 'observed-model', reasoningEffort });
});

it.each(['default', 'instant', 'High', 'invented', 1, {}])('rejects noncanonical wire effort %j', reasoningEffort => {
  expect(inputArgs.safeParse({ ...input(), reasoningEffort }).success).toBe(false);
});


it('binds decision helper provenance from exact ACK and restores it from the durable receipt', async () => {
  const bindHelper = vi.fn(async () => undefined);
  configureInputDelivery({ applyAutomation: automate, changed, bindHelper });
  const controller = new AbortController();
  const answer = requestBrowserDecision('Plan this', controller.signal, { sourceSessionId: sessionId });
  await vi.waitFor(async () => expect(await listInputs()).toHaveLength(1));
  const [row] = await listInputs();
  await claimBrowserInput(row!.id, 'helper-page', null);
  expect(await acknowledgeBrowserInput(row!.id, 'helper-page', 'exact-helper-chat')).toBe(true);
  expect(bindHelper).toHaveBeenCalledWith('exact-helper-chat', sessionId);
  controller.abort(); await expect(answer).rejects.toThrow('goal_browser_cancelled');
  await flushDurable(); resetInputForTests();
  bindHelper.mockClear(); configureInputDelivery({ applyAutomation: automate, changed, bindHelper });
  await listInputs();
  expect(bindHelper).toHaveBeenCalledWith('exact-helper-chat', sessionId);
});

describe('Astra delivery boundaries and stacked direct input', () => {
  it('maps active Astra after-turn to finish durably and preserves original retry identity', async () => {
    binding.activeTurnId = 'active-astra';
    const args = input({ mode: 'after-turn' });
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ queueAtFinish: true, canInject: true, browserAllowed: false });
    expect(await enqueueInput(args)).toMatchObject({ mode: 'finish', requestedMode: 'after-turn' });
    binding.activeTurnId = null;
    resetInputForTests();
    expect(await enqueueInput(args)).toMatchObject({ mode: 'finish', requestedMode: 'after-turn' });
    expect(await offerToolInput(sessionId, binding.conversationId, 'ordinary', now)).toEqual([]);
    expect(await offerToolInput(sessionId, binding.conversationId, 'finish', now, true)).toHaveLength(1);
  });
  it.each(['disabled', 'worker', 'helper', 'non-astra'])('does not map after-turn for %s', async condition => {
    binding.activeTurnId = 'active';
    if (condition === 'disabled') binding.finishEnabled = false;
    if (condition === 'worker' || condition === 'helper') binding.origin = condition;
    if (condition === 'non-astra') binding.model = 'gpt-5.6-pro';
    expect((await sessionInputPolicy(sessionId)).queueAtFinish).toBe(false);
    expect((await enqueueInput(input({ mode: 'after-turn' }))).mode).toBe('after-turn');
  });
  it('rechecks newer bridge activity at the final browser authorization boundary', async () => {
    let active = false;
    configureInputDelivery({ applyAutomation: automate, changed, activity: () => ({ possible: active, exact: active }) });
    const row = await enqueueInput(input());
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
    active = true;
    expect(await sessionInputPolicy(sessionId)).toMatchObject({ queueAtFinish: true, canInject: true, browserAllowed: false });
    expect(await pendingBrowserInputs()).toEqual([]);
    expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(false);
    active = false;
    expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(true);
  });
  it.each([null, { kind: 'turn_end', outcome: 'unknown', turnId: 'unknown', time: 1000 }])('requires confirmed terminal evidence for an existing Astra chat (%j)', async end => {
    binding.end = end;
    const row = await enqueueInput(input());
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId)).toBeNull();
    expect(await pendingBrowserInputs()).toEqual([]);
    await cancelInput(row.id);
    const initial = await enqueueInput(input({ sessionId: null, model: 'gpt-6-astra' }));
    expect(await claimBrowserInput(initial.id, 'fresh', null)).not.toBeNull();
  });
  it('retains non-Astra browser behavior with unknown terminal evidence', async () => {
    binding.model = 'gpt-5.6-sol'; binding.end = null;
    const row = await enqueueInput(input());
    expect(await claimBrowserInput(row.id, 'page', binding.conversationId)).not.toBeNull();
  });
  it('batches all direct instructions in order while leaving finish stages for a separate boundary', async () => {
    binding.activeTurnId = 'active';
    const stage = await enqueueInput(input({ mode: 'finish', text: 'Stage' }));
    const rows: InputEntry[] = [];
    for (let n = 0; n < 66; n++) rows.push(await enqueueInput(input({ text: `Instruction ${n}` })));
    const offered = await offerToolInputBatch(sessionId, binding.conversationId, 'poll', now, true);
    expect(offered.messages).toHaveLength(66);
    expect(offered.messages.map(row => row.text)).toEqual(rows.map(row => row.text));
    expect(JSON.stringify(offered).match(/Use session_finish/g)).toHaveLength(1);
    for (const row of rows) expect(JSON.stringify(offered)).not.toContain(row.id);
    expect((await listInputs()).find(row => row.id === stage.id)?.state).toBe('queued');
    expect(await offerToolInputBatch(sessionId, binding.conversationId, 'same', now, true)).toEqual(offered);
    now++;
    await acknowledgeToolInput(sessionId, binding.conversationId, 'same', now);
    expect((await listInputs()).filter(row => row.state === 'sent')).toHaveLength(66);
    expect(await offerToolInput(sessionId, binding.conversationId, 'same', now, true)).toHaveLength(1);
  });
  it('keeps the one pending normal browser send limit when no turn is active', async () => {
    await enqueueInput(input());
    await expect(enqueueInput(input())).rejects.toThrow('One message');
  });
  it('bounds a multibyte batch with one reminder and delivers the remaining input on the next invocation', async () => {
    binding.activeTurnId = 'active';
    const rows: InputEntry[] = [];
    for (let index = 0; index < 3; index++) rows.push(await enqueueInput(input({ text: `${index}:` + '界'.repeat(15998) })));
    const first = await offerToolInputBatch(sessionId, binding.conversationId, 'request', now);
    expect(first.messages.map(row => row.text)).toEqual(rows.slice(0, 2).map(row => row.text));
    const envelope = '\n--- New instructions from the user ---\n' + first.messages.map(row => row.text).join('\n\n') + '\n\n' + first.reminder;
    expect(Buffer.byteLength(envelope)).toBeLessThanOrEqual(128000);
    expect((await listInputs()).find(row => row.id === rows[2]!.id)?.state).toBe('queued');
    const second = await offerToolInputBatch(sessionId, binding.conversationId, 'request', ++now);
    expect(second.messages.map(row => row.text)).toEqual([rows[2]!.text]);
    expect(second.reminder).toBe(first.reminder);
    expect((await listInputs()).filter(row => row.state === 'sent')).toHaveLength(2);
  });
});

it('admits active direct injections independently across chats and preserves all of them', async () => {
  binding.activeTurnId = 'active';
  const a = await enqueueInput(input({ sessionId, text: 'A' }));
  const b = await enqueueInput(input({ sessionId: 'session-two', text: 'B' }));
  const again = await enqueueInput(input({ sessionId, text: 'A2' }));
  expect([a, b, again].every(row => row.transportIntent === 'tool')).toBe(true);
  now += 60001;
  binding.activeTurnId = null;
  resetInputForTests();
  expect((await listInputs()).filter(row => row.state === 'queued')).toHaveLength(3);
  expect(await offerToolInput(sessionId, 'conversation-a', 'tool-a', now)).toHaveLength(2);
  expect(await offerToolInput('session-two', 'conversation-b', 'tool-b', now)).toHaveLength(1);
});
it('expires an unclaimed ordinary initial browser attempt 60 seconds after its due time', async () => {
  const row = await enqueueInput(input({ sessionId: null, dueAt: now + 120000 }));
  expect(row.transportIntent).toBe('browser');
  now += 179999;
  resetInputForTests();
  expect((await listInputs()).find(entry => entry.id === row.id)?.state).toBe('queued');
  now++;
  expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('60 seconds') });
  expect(await claimBrowserInput(row.id, 'late', null)).toBeNull();
});
it('never times out an intentional after-turn wait or a finish stage', async () => {
  binding.activeTurnId = 'active';
  binding.finishEnabled = false;
  const after = await enqueueInput(input({ mode: 'after-turn', afterTurn: true }));
  const stage = await enqueueInput(input({ mode: 'finish' }));
  now += 86400000;
  resetInputForTests();
  expect((await listInputs()).filter(row => [after.id, stage.id].includes(row.id)).every(row => row.state === 'queued')).toBe(true);
});
it('allows one browser send alongside other-chat tool input but prevents same-chat competing browser sends', async () => {
  binding.activeTurnId = 'active';
  const tool = await enqueueInput(input());
  binding.activeTurnId = null;
  // No terminal proof for the previously active turn: the tool route is still held.
  binding.end = null;
  const browser = await enqueueInput(input({ sessionId: null }));
  expect(browser.transportIntent).toBe('browser');
  expect(await pendingBrowserInputs()).toEqual([{ id: browser.id, conversationId: null }]);
  await expect(enqueueInput(input({ sessionId: null }))).rejects.toThrow('One message');
  await cancelInput(browser.id);
  await expect(enqueueInput(input())).rejects.toThrow('One message');
  expect((await listInputs()).find(row => row.id === tool.id)?.state).toBe('queued');
});

it('recovers only an unoffered tool intent after the target is positively settled', async () => {
  binding.activeTurnId = 'old-active';
  const row = await enqueueInput(input());
  expect(row.transportIntent).toBe('tool');
  binding.activeTurnId = null;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'old-active', time: now + 1 };
  const claimed = await claimBrowserInput(row.id, 'recovery-page', binding.conversationId, true);
  expect(claimed).toMatchObject({ state: 'browser', transportIntent: 'browser' });
  expect(await offerToolInput(sessionId, binding.conversationId, 'competing-tool', now + 2)).toEqual([]);
  expect(await authorizeBrowserInput(row.id, 'recovery-page', binding.conversationId)).toBe(true);
});

it('never redirects a tool input whose offer may already have reached the model', async () => {
  binding.activeTurnId = 'active-tool-turn';
  const row = await enqueueInput(input());
  expect(await offerToolInput(sessionId, binding.conversationId, 'offered-request', now)).toHaveLength(1);
  binding.activeTurnId = null;
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'active-tool-turn', time: now + 1 };
  expect(await claimBrowserInput(row.id, 'other-page', binding.conversationId, true)).toBeNull();
  expect((await listInputs()).find(entry => entry.id === row.id)).toMatchObject({ state: 'tool', offeredAt: now });
});

it('keeps Astra finish-only tasks off browser transport across restart and permits explicit per-task opt-in', async () => {
  const row = await enqueueInput(input({ mode: 'finish' }));
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'astra-ended', time: now + 1 };
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).toBeNull();
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await editQueuedInput(row.id, row.text, true)).toBe(true);
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: binding.conversationId }]);
  expect(await editQueuedInput(row.id, row.text, false)).toBe(true);
  expect(await pendingBrowserInputs()).toEqual([]);
  expect(await offerToolInput(sessionId, binding.conversationId, 'finish-only-test', now, true)).toHaveLength(1);
});
it('elects an opted-in after-turn task past finish-only stages and spends the completed turn once', async () => {
  const blocked = await enqueueInput(input({ mode: 'finish', text: 'Finish-only implementation' }));
  const after = await enqueueInput(input({ mode: 'finish', text: 'Inspect the current result', afterTurn: true }));
  const later = await enqueueInput(input({ mode: 'finish', text: 'Inspect again', afterTurn: true }));
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'astra-ended', time: now + 1 };
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([{ id: after.id, conversationId: binding.conversationId }]);
  expect(await claimBrowserInput(blocked.id, 'page', binding.conversationId, true)).toBeNull();
  expect(await claimBrowserInput(later.id, 'page', binding.conversationId, true)).toBeNull();
  expect(await claimBrowserInput(after.id, 'page', binding.conversationId, true)).not.toBeNull();
  expect(await authorizeBrowserInput(after.id, 'page', binding.conversationId)).toBe(true);
  await acknowledgeBrowserInput(after.id, 'page', 'message-after', binding.conversationId);
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
  expect((await listInputs()).find(row => row.id === blocked.id)?.state).toBe('queued');
});
it('rechecks Astra finish-only policy at final browser authorization after a model change', async () => {
  binding.model = 'gpt-5.6-pro';
  const row = await enqueueInput(input({ mode: 'finish' }));
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'ordinary-ended', time: now + 1 };
  expect(await claimBrowserInput(row.id, 'page', binding.conversationId, true)).not.toBeNull();
  binding.model = 'gpt-6-astra';
  expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(false);
});

it('delivers a legacy finish checkpoint after an ordinary turn without restoring its old Pro selection', async () => {
  const args = input({ mode: 'finish', model: '6', reasoningEffort: 'pro', text: 'Final checkpoint' });
  const row = await enqueueInput(args);
  resetInputForTests();
  binding.model = 'gpt-5.6-sol';
  binding.end = { kind: 'turn_end', outcome: 'completed', turnId: 'ordinary-completed', time: now + 1 };
  expect(await pendingBrowserInputs()).toEqual([{ id: row.id, conversationId: binding.conversationId }]);
  const claimed = await claimBrowserInput(row.id, 'page', binding.conversationId, true);
  expect(claimed).toMatchObject({ model: null, reasoningEffort: null, text: 'Final checkpoint' });
  expect(claimed?.deliveryText).not.toContain('session_finish');
  expect(await authorizeBrowserInput(row.id, 'page', binding.conversationId)).toBe(true);
  // Authored identity remains valid even though browser delivery inherits selection.
  expect(await enqueueInput(args)).toMatchObject({ id: row.id, model: '6', reasoningEffort: 'pro' });
  await acknowledgeBrowserInput(row.id, 'page', binding.conversationId, 'native-checkpoint');
  resetInputForTests();
  expect(await pendingBrowserInputs()).toEqual([]);
});
