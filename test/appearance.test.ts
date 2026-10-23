import { describe, it, expect } from 'vitest';
import { appearanceSchema } from '../src/main/appearance-schema.js';
import { ACCENT_PRESETS, defaultAppearance, effectivePalette, mergeAppearance, paletteTokens, contrastRatio, readableInk } from '../src/shared/appearance.js';
import { titleBarOverlayForTheme, windowBackgroundForTheme } from '../src/main/window-layout.js';

describe('custom appearance', () => {
  it('accepts arbitrary RGB colors, including identical accent and background, and bounds other preferences', () => {
    const appearance = defaultAppearance();
    appearance.dark = { background: '#51a20F', sidebar: '#fE0193', accent: '#51a20F', contrast: 0 };
    expect(appearanceSchema.parse(appearance)).toEqual(appearance);
    for (const bad of ['red', '#fff', '#12345678', 'url(https://example.com)', '#abcdef;display:none']) {
      expect(appearanceSchema.safeParse({ ...appearance, dark: { ...appearance.dark, sidebar: bad } }).success).toBe(false);
    }
    for (const fontSize of [11, 19, 14.5, Infinity]) expect(appearanceSchema.safeParse({ ...appearance, fontSize }).success).toBe(false);
    expect(appearanceSchema.safeParse({ ...appearance, font: 'remote-font' }).success).toBe(false);
  });

  it('retains readable text and buttons across light, dark and vivid custom backgrounds', () => {
    for (const background of ['#000000', '#ffffff', '#777777', '#ff0000', '#00ff00', '#0000ff', '#fea5cf']) {
      for (const contrast of [0, 45, 100]) {
        const tokens = paletteTokens(background, background, contrast);
        expect(contrastRatio(tokens['--ink']!, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--soft']!, tokens['--card']!)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--faint']!, tokens['--card']!)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--blue']!, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--on-accent']!, background)).toBeGreaterThanOrEqual(4.5);
        expect(tokens['--accent-fill']).toBe(background);
      }
    }
  });

  it('merges stale windows per color and per theme without overwriting concurrent edits', () => {
    const base = defaultAppearance(), live = defaultAppearance(), wanted = defaultAppearance();
    live.dark.sidebar = '#ff0066'; live.light.background = '#f1f2f3'; live.font = 'serif';
    wanted.dark.accent = '#7600ff'; wanted.fontSize = 18;
    const merged = mergeAppearance(live, base, wanted)!;
    expect(merged.dark).toEqual({ ...live.dark, accent: '#7600ff' });
    expect(merged.light).toEqual(live.light);
    expect(merged.font).toBe('serif'); expect(merged.fontSize).toBe(18);
    expect(mergeAppearance(live, undefined, undefined)).toBe(live);
    expect(base).toEqual(defaultAppearance());
  });

  it('opens on the Projects sidebar for saves without a layout or with a retired one, and merges the layout per field', () => {
    const old: Record<string, unknown> = { ...defaultAppearance() };
    delete old.sidebarLayout;
    expect(appearanceSchema.parse(old).sidebarLayout).toBe('projects');
    // 'status' was a concept variant that never shipped; it reads as the default tree.
    for (const bad of ['status', 'classic', 1, null]) expect(appearanceSchema.parse({ ...old, sidebarLayout: bad }).sidebarLayout).toBe('projects');
    expect(appearanceSchema.parse({ ...old, sidebarLayout: 'inbox' }).sidebarLayout).toBe('inbox');
    const base = defaultAppearance(), live = { ...defaultAppearance(), sidebarLayout: 'inbox' as const };
    // A stale window saving its font keeps the layout another window chose.
    expect(mergeAppearance(live, base, { ...base, font: 'mono' })).toMatchObject({ sidebarLayout: 'inbox', font: 'mono' });
    expect(mergeAppearance(base, base, live)!.sidebarLayout).toBe('inbox');
  });

  it('bounds line spacing, opens older saves at normal spacing, and offers the bundled legible font', () => {
    const old: Record<string, unknown> = { ...defaultAppearance() };
    delete old.lineSpacing;
    expect(appearanceSchema.parse(old).lineSpacing).toBe(100);
    expect(appearanceSchema.parse({ ...old, lineSpacing: 140, font: 'legible' })).toMatchObject({ lineSpacing: 140, font: 'legible' });
    // Out of range or off the 10-percent steps: normal spacing, the rest of the appearance is kept.
    for (const bad of [99, 201, 142.5, 145, '140', null]) expect(appearanceSchema.parse({ ...old, lineSpacing: bad, font: 'serif' })).toMatchObject({ lineSpacing: 100, font: 'serif' });
    const base = defaultAppearance(), live = { ...defaultAppearance(), lineSpacing: 150 };
    // A stale window saving its text size keeps the spacing another window chose.
    expect(mergeAppearance(live, base, { ...base, fontSize: 16 })).toMatchObject({ lineSpacing: 150, fontSize: 16 });
    expect(mergeAppearance(base, base, live)!.lineSpacing).toBe(150);
  });

  it('uses the custom sidebar for native caption contrast and the custom page for reload backing', () => {
    const appearance = defaultAppearance();
    appearance.dark.sidebar = '#ffffff'; appearance.dark.background = '#391c56'; appearance.translucentSidebar = false;
    expect(titleBarOverlayForTheme('dark', appearance)).toEqual({ height: 36, color: '#00000000', symbolColor: readableInk('#ffffff') });
    expect(windowBackgroundForTheme('dark', appearance)).toBe('#391c56');
  });
});

describe('high contrast and accent presets', () => {
  it('meets WCAG AA for every preset accent on its own theme: links on the page, labels on the accent fill', () => {
    expect(ACCENT_PRESETS).toHaveLength(8);
    expect(new Set(ACCENT_PRESETS.map(preset => preset.id)).size).toBe(8);
    for (const theme of ['light', 'dark'] as const) {
      const page = defaultAppearance()[theme].background;
      for (const preset of ACCENT_PRESETS) {
        const tokens = paletteTokens(page, preset[theme], defaultAppearance()[theme].contrast);
        expect(contrastRatio(tokens['--accent']!, page), `${preset.id} ${theme}`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens['--on-accent']!, preset[theme]), `${preset.id} ${theme} label`).toBeGreaterThanOrEqual(4.5);
        // The swatch itself must stand out from the page as a control (WCAG 1.4.11).
        expect(contrastRatio(preset[theme], page), `${preset.id} ${theme} swatch`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('turns a theme into black or white with text at 7:1 and lines at 3:1, whatever colors were chosen', () => {
    for (const theme of ['light', 'dark'] as const) {
      const appearance = { ...defaultAppearance(), highContrast: true };
      appearance[theme] = { background: '#7a5c99', sidebar: '#33aa77', accent: '#ffcc00', contrast: 10 };
      const palette = effectivePalette(appearance, theme);
      expect(palette.background).toBe(theme === 'dark' ? '#000000' : '#ffffff');
      expect(palette.sidebar).toBe(palette.background);
      const tokens = paletteTokens(palette.background, palette.accent, palette.contrast, true);
      // On every surface text and lines sit on: the page, cards, popovers and hovered rows.
      for (const surface of ['--page', '--card', '--popover', '--hover', '--sunk']) {
        for (const text of ['--ink', '--soft', '--faint', '--accent', '--blue', '--green', '--red']) {
          expect(contrastRatio(tokens[text]!, tokens[surface]!), `${theme} ${text} on ${surface}`).toBeGreaterThanOrEqual(7);
        }
        for (const edge of ['--line', '--edge', '--track', '--accent-edge']) {
          expect(contrastRatio(tokens[edge]!, tokens[surface]!), `${theme} ${edge} on ${surface}`).toBeGreaterThanOrEqual(3);
        }
      }
      expect(contrastRatio(tokens['--on-accent']!, tokens['--accent-fill']!)).toBeGreaterThanOrEqual(7);
    }
  });

  it('leaves the chosen colors alone while high contrast is off, and keeps them for when it is turned off', () => {
    const appearance = defaultAppearance();
    expect(effectivePalette(appearance, 'dark')).toEqual(appearance.dark);
    const on = { ...appearance, highContrast: true };
    expect(on.dark).toEqual(appearance.dark);
  });

  it('opens older saves without high contrast and merges it per field', () => {
    const old: Record<string, unknown> = { ...defaultAppearance() };
    delete old.highContrast;
    // Missing stays missing, which means off.
    expect(appearanceSchema.parse(old).highContrast).toBeUndefined();
    expect(effectivePalette(appearanceSchema.parse(old), 'dark')).toEqual(defaultAppearance().dark);
    for (const bad of ['yes', 1, null]) expect(appearanceSchema.parse({ ...old, highContrast: bad }).highContrast).toBe(false);
    const base = defaultAppearance(), live = { ...defaultAppearance(), highContrast: true };
    // A stale window saving its font keeps high contrast another window turned on.
    expect(mergeAppearance(live, base, { ...base, font: 'serif' })).toMatchObject({ highContrast: true, font: 'serif' });
    expect(mergeAppearance(base, base, live)!.highContrast).toBe(true);
  });
});
