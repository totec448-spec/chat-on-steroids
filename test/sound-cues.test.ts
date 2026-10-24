import { expect, it, vi } from 'vitest';
import { createSoundCues, type SoundCueDeps } from '../src/main/sound-cues.js';

/**
 * #1802: a short sound when a chat needs you, something failed, or a chat finished while the
 * window is in the background. Off by default, quiet in phone notifications' quiet hours, and
 * one sound per chat and kind in two minutes.
 */
function cues(over: Partial<SoundCueDeps> = {}) {
  let now = Date.parse('2026-10-24T12:00:00');
  const play = vi.fn<SoundCueDeps['play']>(), log = vi.fn<SoundCueDeps['log']>();
  const deps: SoundCueDeps = { enabled: () => true, focused: () => false, quietHours: () => null, now: () => now, play, log, ...over };
  return { cue: createSoundCues(deps), deps: { play, log }, advance: (ms: number) => { now += ms; } };
}

it('plays and logs nothing while the setting is off', () => {
  const { cue, deps } = cues({ enabled: () => false });
  expect(cue('needs-you', 's1')).toBe('off');
  expect(deps.play).not.toHaveBeenCalled();
  expect(deps.log).not.toHaveBeenCalled();
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
