import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderRecoveryCountdowns } from '../src/renderer/recovery.js';

let dom: JSDOM, host: HTMLElement;
beforeEach(() => {
  dom = new JSDOM('<div id="recovery" hidden></div>');
  vi.stubGlobal('document', dom.window.document);
  host = document.getElementById('recovery')!;
});
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });

it('ticks the actual deadline without rebuilding the row or claiming an action at zero', () => {
  const countdowns = [{ kind: 'thinking-failed' as const, deadline: 300_000 }];
  expect(renderRecoveryCountdowns(host, countdowns, 0)).toBe(true);
  expect(host.textContent).toContain('Check in 5:00');
  const row = host.firstElementChild;
  renderRecoveryCountdowns(host, countdowns, 1_001);
  expect(host.textContent).toContain('Check in 4:59');
  expect(host.firstElementChild).toBe(row);
  renderRecoveryCountdowns(host, countdowns, 305_000);
  expect(host.textContent).toContain('Checking for activity…');
  expect(host.textContent).not.toContain('sent');
  expect(host.querySelector('[role="timer"]')?.getAttribute('aria-live')).toBe('off');
  renderRecoveryCountdowns(host, [{ kind: 'native-busy', deadline: 605_000 }], 305_000);
  expect(host.textContent).toContain('Check in 5:00');
});

it('can show concurrent attribution and listening waits and relinquishes the host when cancelled', () => {
  renderRecoveryCountdowns(host, [{ kind: 'unattributed', deadline: 15_000 }, { kind: 'thinking-failed', deadline: 300_000 }], 0);
  expect(host.querySelectorAll('.recovery-notice')).toHaveLength(2);
  expect(host.textContent).toContain('Reload in 0:15');
  renderRecoveryCountdowns(host, [{ kind: 'unattributed', deadline: 15_000 }], 16_000);
  expect(host.textContent).toContain('Reload pending…');
  expect(host.querySelectorAll('.recovery-notice')).toHaveLength(1);
  expect(renderRecoveryCountdowns(host, [], 16_000)).toBe(false);
  expect(host.dataset.countdowns).toBeUndefined();
});

it('shows the remaining five-minute attribution window without promising another reload', () => {
  renderRecoveryCountdowns(host, [{ kind: 'unattributed-wait', deadline: 300_000 }], 60_000);
  expect(host.textContent).toContain('Unattributed activity · awaiting attribution');
  expect(host.textContent).toContain('Check in 4:00');
  expect(host.textContent).not.toContain('Reload in');
  renderRecoveryCountdowns(host, [{ kind: 'unattributed-wait', deadline: 300_000 }], 299_001);
  expect(host.textContent).toContain('Check in 0:01');
});

it('reveals Pro silence at five minutes using the UI clock and hides again when activity renews it', () => {
  const countdown = { kind: 'silence' as const, deadline: 600_000, visibleAt: 300_000 };
  expect(renderRecoveryCountdowns(host, [countdown], 299_999)).toBe(true);
  expect(host.hidden).toBe(true);
  renderRecoveryCountdowns(host, [countdown], 300_000);
  expect(host.hidden).toBe(false);
  expect(host.textContent).toContain('Reload in 5:00');
  renderRecoveryCountdowns(host, [{ ...countdown, visibleAt: 600_000, deadline: 900_000 }], 300_000);
  expect(host.hidden).toBe(true);
  renderRecoveryCountdowns(host, [countdown, { kind: 'post-reload', deadline: 359_999 }], 299_999);
  expect(host.hidden).toBe(false);
  expect((host.firstElementChild as HTMLElement).hidden).toBe(true);
  expect(host.lastElementChild?.textContent).toContain('Check in 1:00');
});

it.each(['queue', 'goal', 'loop'] as const)('names %s as the next step without claiming it was sent', next => {
  renderRecoveryCountdowns(host, [{ kind: 'post-reload', next, deadline: 60_000 }], 0);
  expect(host.textContent).toContain(`Reloaded · next: ${next === 'queue' ? 'Queued message' : next === 'goal' ? 'Goal' : 'Loop'}`);
  expect(host.textContent).toContain('Check in 1:00');
});

it('projects the conditional Continue deadline and never claims delivery at zero', () => {
  const countdown = { kind: 'native-busy' as const, next: 'continue' as const, deadline: 60_000 };
  renderRecoveryCountdowns(host, [countdown], 0);
  expect(host.textContent).toContain('Automatic Continue');
  expect(host.textContent).toContain('Continue in 1:00');
  renderRecoveryCountdowns(host, [countdown], 60_000);
  expect(host.textContent).toContain('Preparing Continue…');
  expect(host.textContent).not.toContain('sent');
});

it('shows the existing ticket pickup deadline after the native busy wait', () => {
  const countdown = { kind: 'pickup' as const, next: 'continue' as const, deadline: 120_000 };
  renderRecoveryCountdowns(host, [countdown], 0);
  expect(host.textContent).toContain('Waiting for delivery · next: Automatic Continue');
  expect(host.textContent).toContain('Reload in 2:00');
  renderRecoveryCountdowns(host, [countdown], 120_000);
  expect(host.textContent).toContain('Reload pending…');
  expect(host.textContent).not.toContain('sent');
});
