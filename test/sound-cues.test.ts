import { expect, it, vi } from 'vitest';
import { createSoundCues, type SoundCueDeps } from '../src/main/sound-cues.js';

/**
 * #1802: a short sound when a chat needs you, something failed, or a chat finished while the
 * window is in the background. Off by default, quiet in phone notifications' quiet hours, and
 * one sound per chat and kind in two minutes.
 */
function cues(over: Partial<SoundCueDeps> = {}) {
  let now = Date.parse('2026-10-24T12:00:00');
  const play = vi.fn<SoundCueDeps['play']>(() => true), log = vi.fn<SoundCueDeps['log']>();
  const deps: SoundCueDeps = { enabled: () => true, focused: () => false, quietHours: () => null, now: () => now, play, log, ...over };
  return { cue: createSoundCues(deps), deps: { play, log }, advance: (ms: number) => { now += ms; } };
}

it('plays nothing while the setting is off, and says so once rather than for every event', () => {
  let on = false;
  const { cue, deps } = cues({ enabled: () => on });
  expect(cue('needs-you', 's1')).toBe('off');
  expect(cue('finished', 's2')).toBe('off');
  expect(deps.play).not.toHaveBeenCalled();
  expect(deps.log.mock.calls).toEqual([['sound: needs-you not played (off; sounds are off, later cues are not logged until they are on)']]);
  // Switched on and off again: it says so once more.
  on = true; cue('failed');
  on = false; cue('failed');
  expect(deps.log.mock.calls.at(-1)).toEqual(['sound: failed not played (off; sounds are off, later cues are not logged until they are on)']);
});

it('counts a cue as played only once the window says it can play sounds, and not across a reload (#1830)', async () => {
  const { createSoundReadiness } = await import('../src/main/sound-cues.js');
  const listeners = new Map<string, Array<() => void>>();
  const page = { on: (event: string, run: () => void) => { listeners.set(event, [...(listeners.get(event) ?? []), run]); } };
  const fire = (event: string) => { for (const run of listeners.get(event) ?? []) run(); };
  const readiness = createSoundReadiness();
  expect(readiness.ready(page)).toBe(false);
  readiness.mark(page);
  expect(readiness.ready(page)).toBe(true);
  // A reload or a crashed page has no listener until it says so again.
  fire('did-start-loading');
  expect(readiness.ready(page)).toBe(false);
  readiness.mark(page);
  fire('render-process-gone');
  expect(readiness.ready(page)).toBe(false);
  expect(readiness.ready(null)).toBe(false);
  // However often the page says it is ready, it is watched once.
  readiness.mark(page); readiness.mark(page);
  expect(listeners.get('did-start-loading')).toHaveLength(1);
});

it('plays needs-you and failed sounds even at the window, a finished one only in the background', () => {
  const { cue, deps } = cues({ focused: () => true });
  expect(cue('needs-you', 's1')).toBe('played');
  expect(cue('failed')).toBe('played');
  expect(cue('finished', 's2')).toBe('at-window');
  expect(deps.play.mock.calls).toEqual([['needs-you'], ['failed']]);
});

it('stays quiet in quiet hours, including hours that cross midnight', () => {
  const late = cues({ quietHours: () => ({ from: '22:00', to: '07:00' }), now: () => Date.parse('2026-10-24T23:30:00') });
  expect(late.cue('failed')).toBe('quiet-hours');
  const day = cues({ quietHours: () => ({ from: '22:00', to: '07:00' }) });
  expect(day.cue('failed')).toBe('played');
});

it('plays one sound per chat and kind in two minutes, and again after', () => {
  const { cue, deps, advance } = cues();
  expect(cue('finished', 's1')).toBe('played');
  expect(cue('finished', 's1')).toBe('repeat');
  expect(cue('finished', 's2')).toBe('played');
  expect(cue('needs-you', 's1')).toBe('played');
  advance(2 * 60_000);
  expect(cue('finished', 's1')).toBe('played');
  expect(deps.play).toHaveBeenCalledTimes(4);
});

it('writes one log line for every decision, without the chat', () => {
  const { cue, deps } = cues({ focused: () => true });
  cue('finished', 'secret-session-id');
  expect(deps.log).toHaveBeenCalledWith('sound: finished not played (at-window)');
  expect(JSON.stringify(deps.log.mock.calls)).not.toContain('secret-session-id');
});

it('does not count a sound no window received, so it plays once a window can', () => {
  let windowOpen = false;
  const { cue, deps } = cues({ play: vi.fn<SoundCueDeps['play']>(() => windowOpen) });
  expect(cue('needs-you', 's1')).toBe('no-window');
  windowOpen = true;
  expect(cue('needs-you', 's1')).toBe('played');
  expect(deps.log.mock.calls.map(call => call[0])).toEqual(['sound: needs-you not played (no-window)', 'sound: needs-you played']);
});

it('keeps quiet hours for sounds even when phone notifications are off (Haz on #1830)', async () => {
  const { soundQuietHours } = await import('../src/main/sound-cues.js');
  const hours = { from: '22:00', to: '07:00' };
  expect(soundQuietHours({ phonePush: { enabled: false, quietHours: hours } } as any)).toEqual(hours);
  expect(soundQuietHours({ phonePush: { enabled: true, quietHours: hours } } as any)).toEqual(hours);
  expect(soundQuietHours({ phonePush: { enabled: true, quietHours: null } } as any)).toBeNull();
  expect(soundQuietHours({} as any)).toBeNull();
});
