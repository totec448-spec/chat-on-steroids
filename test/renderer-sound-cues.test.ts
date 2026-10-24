import { afterEach, expect, it, vi } from 'vitest';

/** #1802: each cue is a few soft notes made with Web Audio; no audio never becomes an error. */
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function fakeAudio() {
  const started: number[] = [];
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  class FakeContext {
    state = 'suspended'; currentTime = 0; destination = {};
    resume = vi.fn(async () => { this.state = 'running'; });
    createOscillator() { const tone = { type: '', frequency: param(), connect: (next: unknown) => next, start: (at: number) => started.push(at), stop: vi.fn() }; return tone; }
    createGain() { return { gain: param(), connect: (next: unknown) => next }; }
  }
  vi.stubGlobal('AudioContext', FakeContext);
  return started;
}

it('plays two notes for finished and failed, three for needs-you, from one reused context', async () => {
  const started = fakeAudio();
  const { playSoundCue } = await import('../src/renderer/sound-cues.js');
  playSoundCue('finished'); expect(started).toHaveLength(2);
  playSoundCue('needs-you'); expect(started).toHaveLength(5);
  playSoundCue('failed'); expect(started).toHaveLength(7);
});

it('does nothing, and throws nothing, where there is no audio', async () => {
  vi.stubGlobal('AudioContext', class { constructor() { throw new Error('no audio device'); } });
  const { playSoundCue } = await import('../src/renderer/sound-cues.js');
  expect(() => playSoundCue('failed')).not.toThrow();
});
