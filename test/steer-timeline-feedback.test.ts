import { describe, expect, it, vi } from 'vitest';
import { T0, boot, text, toolCall, type SessionEvent } from './renderer-timeline.harness.js';

vi.mock('../src/renderer/workspace-terminal.js', () => ({ createWorkspaceTerminal: () => ({
  update: vi.fn(), show: vi.fn(), hide: vi.fn(), hasTabs: () => false,
  tabs: () => [], newTab: () => null, selectTab: vi.fn(), closeTab: vi.fn()
}) }));
vi.mock('../src/renderer/pet.js', () => ({ initPet: () => Object.assign(() => {}, { toggle: () => {}, isVisible: () => false }) }));
vi.mock('../src/renderer/file-code-editor.js', () => ({
  createProjectDiffViewer: async ({ parent, baseText, currentText }: { parent: HTMLElement; baseText: string; currentText: string }) => {
    const view = parent.ownerDocument.createElement('pre');
    view.textContent = `${baseText}\n---\n${currentText}`;
    parent.append(view);
    return { destroy: () => view.remove(), language: 'TypeScript' };
  }
}));

function idleControls(w: any) {
  w.api.getSessionControls = (id: string) => Promise.resolve({
    ok: true,
    data: { sessionId: id, automation: 'off', activeTurnId: null, finishHeld: false, blocked: '', job: null }
  });
}

describe('steer timeline feedback', () => {
  it('retains pre-steer worked duration even when interrupted with continued: true and badges the steered prompt', async () => {
    const events: SessionEvent[] = [
      { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension', turnId: 'q-1', messageId: 'm-1', message: text('Initial request') },
      { kind: 'turn_start', seq: 2, time: T0 + 100, source: 'extension', turnId: 'turn-1' },
      { ...toolCall(3, 'call-1'), time: T0 + 5_000, turnId: 'turn-1' },
      // Consolidated final answer retains original Turn 1 timestamp, but finalized at T0 + 79_000.
      {
        kind: 'assistant_message',
        seq: 4,
        origin: 4,
        contentSeq: 40,
        finalContentSeq: 40,
        time: T0 + 1_000,
        finalObservedAt: T0 + 79_000,
        source: 'extension',
        turnId: 'turn-1',
        messageId: 'a-1',
        message: text('Combined final response after steer'),
        state: 'final',
        final: true
      },
      // User steers at T0 + 45_000; Turn 1 rotates slightly after with interrupted + continued: true.
      { kind: 'user_message', seq: 5, origin: 5, time: T0 + 45_000, source: 'extension', messageId: 'm-2', message: text('Focus on tests first') },
      { kind: 'turn_end', seq: 6, time: T0 + 45_200, source: 'extension', turnId: 'turn-1', outcome: 'interrupted', continued: true },
      { kind: 'turn_start', seq: 7, time: T0 + 45_300, source: 'extension', turnId: 'turn-2' },
      { ...toolCall(8, 'call-2'), time: T0 + 60_000, turnId: 'turn-2' },
      { kind: 'turn_end', seq: 9, time: T0 + 80_000, source: 'extension', turnId: 'turn-2', outcome: 'completed' }
    ];

    const { w, append } = await boot(events);
    idleControls(w);
    await append([]);

    const lines = [...w.document.querySelectorAll<HTMLElement>('#timeline .turn-worked')];
    expect(lines.map(line => line.textContent)).toEqual(['Worked for 45s · steered', 'Worked for 35s']);
    expect(lines[0]!.classList.contains('is-steered')).toBe(true);
    expect(lines[1]!.classList.contains('is-steered')).toBe(false);

    const userRows = [...w.document.querySelectorAll<HTMLElement>('#timeline .ev-user_message')];
    expect(userRows).toHaveLength(2);
    expect(userRows[0]!.classList.contains('is-steered')).toBe(false);
    expect(userRows[0]!.querySelector('.said-origin.is-steer')).toBeNull();
    expect(userRows[1]!.classList.contains('is-steered')).toBe(true);
    expect(userRows[1]!.querySelector('.said-origin.is-steer')?.textContent).toBe('Steered active turn');
  });

  it('shows the steer badge live before turn_end arrives and closes the pre-steer segment once it does', async () => {
    const initial: SessionEvent[] = [
      { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension', turnId: 'turn-live', messageId: 'm-live-1', message: text('Start task') },
      { kind: 'turn_start', seq: 2, time: T0 + 100, source: 'extension', turnId: 'turn-live' },
      { ...toolCall(3, 'call-live-1'), time: T0 + 4_000, turnId: 'turn-live' }
    ];

    const { w, append } = await boot(initial);
    // Steer arrives while turn-live has not ended yet.
    await append([
      { kind: 'user_message', seq: 4, origin: 4, time: T0 + 12_000, source: 'extension', messageId: 'm-live-2', via: 'telegram', message: text('Check edge cases too') }
    ]);

    let userRows = [...w.document.querySelectorAll<HTMLElement>('#timeline .ev-user_message')];
    expect(userRows).toHaveLength(2);
    expect(userRows[0]!.classList.contains('is-steered')).toBe(false);
    expect(userRows[1]!.classList.contains('is-steered')).toBe(true);
    expect([...userRows[1]!.querySelectorAll('.said-origin')].map(el => el.textContent)).toEqual([
      'From Telegram',
      'Steered active turn'
    ]);

    // Turn rotates via continued: true and finishes on Turn 2.
    await append([
      { kind: 'turn_end', seq: 5, time: T0 + 12_100, source: 'extension', turnId: 'turn-live', outcome: 'interrupted', continued: true },
      { kind: 'turn_start', seq: 6, time: T0 + 12_200, source: 'extension', turnId: 'turn-live-2' },
      { kind: 'turn_end', seq: 7, time: T0 + 25_000, source: 'extension', turnId: 'turn-live-2', outcome: 'completed' }
    ]);
    idleControls(w);
    await append([]);

    const lines = [...w.document.querySelectorAll<HTMLElement>('#timeline .turn-worked')];
    expect(lines.map(line => line.textContent)).toEqual(['Worked for 12s · steered', 'Worked for 13s']);
    userRows = [...w.document.querySelectorAll<HTMLElement>('#timeline .ev-user_message')];
    expect(userRows[1]!.classList.contains('is-steered')).toBe(true);
  });

  it('does not mark normal turns, uncontinued interrupts, or automatic continuations as steered', async () => {
    const events: SessionEvent[] = [
      // Turn 1: automatic Continue (continued: true) then completed normally — followed later by a normal Turn 2 ask.
      { kind: 'user_message', seq: 1, origin: 1, time: T0, source: 'extension', turnId: 'auto-1', messageId: 'q-auto', message: text('Long report') },
      { kind: 'turn_start', seq: 2, time: T0 + 50, source: 'extension', turnId: 'auto-1' },
      { kind: 'turn_end', seq: 3, time: T0 + 10_000, source: 'extension', turnId: 'auto-1', outcome: 'completed', continued: true },
      { kind: 'turn_start', seq: 4, time: T0 + 10_100, source: 'extension', turnId: 'auto-2' },
      { kind: 'assistant_message', seq: 5, time: T0 + 25_000, source: 'extension', turnId: 'auto-2', messageId: 'a-auto', message: text('Done'), final: true, state: 'final' },
      { kind: 'turn_end', seq: 6, time: T0 + 25_000, source: 'extension', turnId: 'auto-2', outcome: 'completed' },
      // Turn 3: interrupted without continuation, then a fresh prompt.
      { kind: 'user_message', seq: 7, origin: 7, time: T0 + 60_000, source: 'extension', turnId: 'int-1', messageId: 'q-int', message: text('Interrupted ask') },
      { kind: 'turn_start', seq: 8, time: T0 + 60_050, source: 'extension', turnId: 'int-1' },
      { kind: 'turn_end', seq: 9, time: T0 + 70_000, source: 'extension', turnId: 'int-1', outcome: 'interrupted' },
      { kind: 'user_message', seq: 10, origin: 10, time: T0 + 90_000, source: 'extension', turnId: 'fresh-1', messageId: 'q-fresh', message: text('Fresh follow-up') },
      { kind: 'turn_start', seq: 11, time: T0 + 90_050, source: 'extension', turnId: 'fresh-1' },
      { kind: 'turn_end', seq: 12, time: T0 + 99_000, source: 'extension', turnId: 'fresh-1', outcome: 'completed' },
      // Turn 4: automatic user follow-up arrives while running and turn closes with delayed continued: true.
      { kind: 'user_message', seq: 13, origin: 13, time: T0 + 120_000, source: 'extension', turnId: 'auto-msg-1', messageId: 'q-auto-parent', message: text('Primary prompt') },
      { kind: 'turn_start', seq: 14, time: T0 + 120_050, source: 'extension', turnId: 'auto-msg-1' },
      { kind: 'user_message', seq: 15, origin: 15, time: T0 + 130_000, source: 'extension', automatic: true, turnId: 'auto-msg-2', messageId: 'q-auto-follow', message: text('Continue automatically') },
      { kind: 'turn_end', seq: 16, time: T0 + 130_200, source: 'extension', turnId: 'auto-msg-1', outcome: 'completed', continued: true },
      { kind: 'turn_start', seq: 17, time: T0 + 130_300, source: 'extension', turnId: 'auto-msg-2' },
      { kind: 'turn_end', seq: 18, time: T0 + 142_000, source: 'extension', turnId: 'auto-msg-2', outcome: 'completed' }
    ];

    const { w, append } = await boot(events);
    idleControls(w);
    await append([]);

    expect(w.document.querySelectorAll('#timeline .is-steered')).toHaveLength(0);
    expect(w.document.querySelectorAll('#timeline .said-origin.is-steer')).toHaveLength(0);
    const lines = [...w.document.querySelectorAll<HTMLElement>('#timeline .turn-worked')];
    expect(lines.map(line => line.textContent)).toEqual(['Worked for 25s', 'Worked for 9s', 'Worked for 10s', 'Worked for 12s']);
    expect(lines.every(line => !line.classList.contains('is-steered'))).toBe(true);
  });
});
