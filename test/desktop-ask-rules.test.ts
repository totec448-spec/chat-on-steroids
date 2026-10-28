import { expect, it } from 'vitest';
import { ASK_ACTIVE_MS, ASK_GRANT_MS, desktopAskDecision, type DesktopAskInput } from '../src/shared/desktop-ask.js';

/**
 * #1804 (Haz's review): before a desktop step takes the real mouse or keyboard, the app may ask.
 * Off asks never. "Ask while I'm using the computer" asks when the person's own input is under
 * 30 s old; the app's own input (which also resets the system's idle time) does not count.
 * "Always ask" asks every time a chat has no grant. Go ahead grants that chat 2 minutes, ended
 * early by the person's next input. Missing idle information asks.
 */
const now = 1_000_000;
const input = (over: Partial<DesktopAskInput>): DesktopAskInput => ({
  mode: 'active', now, lastPersonInputAt: now - 5_000, locked: false, lastAppStepEndedAt: null, grant: null, ...over
});

it('never asks when the setting is off', () => {
  expect(desktopAskDecision(input({ mode: 'off' }))).toEqual({ ask: false, why: 'off' });
});

it('asks while the person used the computer in the last 30 seconds, and runs when they are away', () => {
  expect(desktopAskDecision(input({}))).toEqual({ ask: true, why: 'active' });
  expect(desktopAskDecision(input({ lastPersonInputAt: now - ASK_ACTIVE_MS - 1 }))).toEqual({ ask: false, why: 'away' });
  // A locked screen or screen saver is away.
  expect(desktopAskDecision(input({ locked: true }))).toEqual({ ask: false, why: 'locked' });
});

it("does not count the app's own input as the person's", () => {
  // The last input is the app's step, which ended 3 s ago: the idle time says "3 s", the person is away.
  expect(desktopAskDecision(input({ lastPersonInputAt: now - 3_000, lastAppStepEndedAt: now - 3_000 }))).toEqual({ ask: false, why: 'away' });
  // The idle time is counted in whole seconds, so input up to a second after the step is still the app's.
  expect(desktopAskDecision(input({ lastPersonInputAt: now - 2_100, lastAppStepEndedAt: now - 3_000 }))).toEqual({ ask: false, why: 'away' });
  // Input clearly after the step is the person's.
  expect(desktopAskDecision(input({ lastPersonInputAt: now - 1_000, lastAppStepEndedAt: now - 3_000 }))).toEqual({ ask: true, why: 'active' });
});

it('asks when the system cannot say when the person last used it (fails closed)', () => {
  expect(desktopAskDecision(input({ lastPersonInputAt: null }))).toEqual({ ask: true, why: 'unknown' });
});

it('always asks in Always ask, even when the person is away or the screen is locked', () => {
  expect(desktopAskDecision(input({ mode: 'always', lastPersonInputAt: now - 600_000 }))).toEqual({ ask: true, why: 'always' });
  expect(desktopAskDecision(input({ mode: 'always', locked: true }))).toEqual({ ask: true, why: 'always' });
});

it("runs within a chat's 2-minute grant, until it ends or the person uses the computer again", () => {
  const grant = { since: now - 10_000, until: now - 10_000 + ASK_GRANT_MS };
  for (const mode of ['active', 'always'] as const) {
    // Only the app's own steps since Go ahead: the grant holds.
    expect(desktopAskDecision(input({ mode, grant, lastPersonInputAt: now - 4_000, lastAppStepEndedAt: now - 4_000 }))).toEqual({ ask: false, why: 'grant' });
    // The person moved the mouse after Go ahead and after the app's last step: the grant is over.
    expect(desktopAskDecision(input({ mode, grant, lastPersonInputAt: now - 1_000, lastAppStepEndedAt: now - 4_000 })).ask).toBe(true);
    // Two minutes passed.
    expect(desktopAskDecision(input({ mode, grant: { since: now - ASK_GRANT_MS - 1, until: now - 1 }, lastPersonInputAt: now - 1_000 })).ask).toBe(true);
  }
  // Input the person made before pressing Go ahead does not end it.
  expect(desktopAskDecision(input({ grant: { since: now - 1_000, until: now + 100_000 }, lastPersonInputAt: now - 1_500 }))).toEqual({ ask: false, why: 'grant' });
  // Without idle information a grant cannot see the person return, so it is not trusted.
  expect(desktopAskDecision(input({ grant, lastPersonInputAt: null })).ask).toBe(true);
});

it('takes the question\'s colors from the app\'s own palette, so its text is readable on any background and in high contrast (Haz on #1864)', async () => {
  const { desktopAskColors } = await import('../src/shared/desktop-ask.js');
  const { contrastRatio, defaultAppearance } = await import('../src/shared/appearance.js');
  // A mid-grey custom background: fixed dark or light ink would be hard to read on it.
  const grey = { ...defaultAppearance(), light: { ...defaultAppearance().light, background: '#8a8a8a' } };
  const colors = desktopAskColors(grey, 'light');
  expect(colors.background).toBe('#8a8a8a');
  expect(contrastRatio(colors.ink, colors.background)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(colors.soft, colors.background)).toBeGreaterThanOrEqual(4.5);
  for (const value of Object.values(colors)) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
  // The app's high-contrast setting carries over.
  const high = desktopAskColors({ ...defaultAppearance(), highContrast: true }, 'dark');
  expect(contrastRatio(high.ink, high.background)).toBeGreaterThanOrEqual(7);
});

it('keeps the buttons readable on hover, on a background where the app\'s hover shade would not be (CodeRabbit on #1864)', async () => {
  const { readFileSync } = await import('node:fs');
  const { desktopAskColors } = await import('../src/shared/desktop-ask.js');
  const { contrastRatio, defaultAppearance } = await import('../src/shared/appearance.js');
  for (const background of ['#767676', '#8a8a8a', '#f4f4f5', '#181818']) for (const contrast of [0, 45, 100]) {
    const colors = desktopAskColors({ ...defaultAppearance(), light: { ...defaultAppearance().light, background, contrast } }, 'light');
    expect(contrastRatio(colors.ink, colors.hover), `${background} at ${contrast}`).toBeGreaterThanOrEqual(4.5);
  }
  // Go ahead keeps its colors on hover (no fading); the hover shows as a ring.
  const css = readFileSync('src/renderer/desktop-ask.css', 'utf8');
  expect(css.match(/\.btn-solid:hover \{[^}]*\}/)?.[0]).not.toMatch(/opacity|background/);
});
