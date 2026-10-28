import { describe, expect, it } from 'vitest';
import { createStartupTiming, type StartupRun } from '../src/main/startup-timing.js';

function timing(previous: unknown = null) {
  let clock = 0;
  const logged: string[] = [];
  const saved: StartupRun[][] = [];
  const timer = createStartupTiming({ clock: () => clock, now: () => 1_800_000_000_000, version: '2.1.47',
    log: line => logged.push(line), save: runs => saved.push(runs) });
  timer.restore(previous);
  return { timer, logged, saved, at: (ms: number) => { clock = ms; } };
}

describe('startup timing', () => {
  it('stamps each step once, in ms since the process started, and says once when the app is usable', () => {
    const { timer, logged, at } = timing();
    at(310.4); timer.mark('ready');
    at(520); timer.mark('config');
    at(600); timer.mark('config');
    at(1_800); timer.mark('restored');
    at(2_100); timer.mark('window');
    expect(logged).toEqual([]);
    at(2_410); timer.mark('renderer');
    expect(timer.current().steps).toEqual({ ready: 310, config: 520, restored: 1_800, window: 2_100, renderer: 2_410 });
    expect(logged).toEqual(['startup: usable after 2.41 s (Electron ready 0.31 s, settings 0.52 s, chats restored 1.80 s, window loaded 2.10 s, app window ready 2.41 s)']);
    at(3_000); timer.mark('renderer');
    expect(logged).toHaveLength(1);
  });

  it('keeps the steps that come after the app is usable, in the order they happened, and saves the run each time', () => {
    const { timer, saved, at } = timing();
    at(2_000); timer.mark('renderer');
    at(2_900); timer.mark('tunnel');
    at(3_400); timer.mark('extension');
    at(3_600); timer.mark('window');
    expect(saved.at(-1)?.at(-1)).toMatchObject({ version: '2.1.47', steps: { renderer: 2_000, tunnel: 2_900, extension: 3_400 } });
    expect(saved).toHaveLength(4);
    expect(timer.lines()[0]).toBe('This start: usable after 2.00 s (app window ready 2.00 s); ChatGPT tunnel 2.90 s, browser extension 3.40 s, window loaded 3.60 s');
  });

  it('keeps the last ten starts, drops damaged ones, and compares this start with the earlier ones', () => {
    const earlier = [
      ...Array.from({ length: 11 }, (_, index) => ({ at: index, version: '2.1.46', steps: { renderer: 1_000 + index * 100 } })),
      { at: 99, version: '2.1.46', steps: { renderer: 'slow' } },
      'damaged'
    ];
    const { timer, saved, at } = timing(earlier);
    at(1_500); timer.mark('renderer');
    const runs = saved.at(-1)!;
    expect(runs).toHaveLength(10);
    expect(runs.at(-1)!.steps.renderer).toBe(1_500);
    expect(runs[0]!.steps.renderer).toBe(1_200);
    // The nine earlier starts kept: 1.20 … 2.00 s.
    expect(timer.lines()[1]).toBe('Earlier starts (9): usable after 1.60 s typically, 1.20 s at the fastest, 2.00 s at the slowest');
  });

  it('drops a saved run that never became usable, which this app never saves (CodeRabbit)', () => {
    const earlier = [
      ...Array.from({ length: 9 }, (_, index) => ({ at: index, version: '2.1.46', steps: { ready: 300 } })),
      { at: 50, version: '2.1.46', steps: { ready: 300, renderer: 1_700 } }
    ];
    const { timer, saved, at } = timing(earlier);
    at(1_500); timer.mark('renderer');
    expect(saved.at(-1)!.map(run => run.steps.renderer)).toEqual([1_700, 1_500]);
    expect(timer.lines()[1]).toBe('Earlier starts (1): usable after 1.70 s typically, 1.70 s at the fastest, 1.70 s at the slowest');
  });

  it('says so when this start is not usable yet, and leaves out earlier starts when there are none', () => {
    const { timer, at } = timing('not a list');
    at(400); timer.mark('ready');
    expect(timer.lines()).toEqual(['This start: not usable yet (Electron ready 0.40 s)']);
  });
});
