/** Saved appearance is presentation only. Theme remains the existing ui.theme choice. */
/** 'legible' is the bundled Atkinson Hyperlegible Next (font-src is 'self', so it ships with the app). */
export const APPEARANCE_FONTS = ['system', 'sans', 'serif', 'mono', 'legible'] as const;
/** 'projects' is the project tree; 'inbox' is one list of chats, active ones first. */
export const SIDEBAR_LAYOUTS = ['projects', 'inbox'] as const;
export type AppearanceTheme = 'light' | 'dark';
export interface AppearancePalette {
  background: string;
  sidebar: string;
  accent: string;
  contrast: number;
}
export interface AppearanceSettings {
  light: AppearancePalette;
  dark: AppearancePalette;
  font: typeof APPEARANCE_FONTS[number];
  fontSize: number;
  /** Chat text line height in percent of the normal one, 100–200. */
  lineSpacing: number;
  translucentSidebar: boolean;
  sidebarLayout: typeof SIDEBAR_LAYOUTS[number];
  /** Black or white page, text at 7:1, lines at 3:1; the chosen colors wait underneath. Missing means off. */
  highContrast?: boolean;
}
export function defaultAppearance(): AppearanceSettings {
  return {
    light: { background: '#f4f4f5', sidebar: '#e9edf2', accent: '#486f9d', contrast: 45 },
    dark: { background: '#181818', sidebar: '#1a2129', accent: '#b0cbed', contrast: 60 },
    font: 'system', fontSize: 14, lineSpacing: 100, translucentSidebar: true, sidebarLayout: 'projects', highContrast: false
  };
}

/** Field-wise three-way merge, so an unrelated save cannot undo another window's colors. */
export function mergeAppearance(live: AppearanceSettings | undefined, base: AppearanceSettings | undefined,
  wanted: AppearanceSettings | undefined): AppearanceSettings | undefined {
  if (!wanted) return live;
  const current = live ?? defaultAppearance(), before = base ?? defaultAppearance();
  const pick = <T>(a: T, b: T, c: T): T => Object.is(b, c) ? a : c;
  const palette = (theme: AppearanceTheme): AppearancePalette => ({
    background: pick(current[theme].background, before[theme].background, wanted[theme].background),
    sidebar: pick(current[theme].sidebar, before[theme].sidebar, wanted[theme].sidebar),
    accent: pick(current[theme].accent, before[theme].accent, wanted[theme].accent),
    contrast: pick(current[theme].contrast, before[theme].contrast, wanted[theme].contrast)
  });
  return { light: palette('light'), dark: palette('dark'), font: pick(current.font, before.font, wanted.font),
    fontSize: pick(current.fontSize, before.fontSize, wanted.fontSize),
    lineSpacing: pick(current.lineSpacing, before.lineSpacing, wanted.lineSpacing),
    translucentSidebar: pick(current.translucentSidebar, before.translucentSidebar, wanted.translucentSidebar),
    sidebarLayout: pick(current.sidebarLayout, before.sidebarLayout, wanted.sidebarLayout),
    highContrast: pick(current.highContrast === true, before.highContrast === true, wanted.highContrast === true) };
}

function channels(hex: string): number[] {
  return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
}
export function mixColor(a: string, b: string, amount: number): string {
  const right = channels(b);
  return '#' + channels(a).map((value, i) => Math.round(value + (right[i]! - value) * amount)
    .toString(16).padStart(2, '0')).join('');
}
export function luminance(color: string): number {
  const linear = channels(color).map(value => {
    const n = value / 255;
    return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
  });
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722;
}
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
export function readableInk(background: string): string {
  return contrastRatio(background, '#ffffff') > contrastRatio(background, '#000000') ? '#ffffff' : '#000000';
}
function readableTint(color: string, background: string, ratio: number): string {
  const ink = readableInk(background);
  for (let step = 0; step <= 20; step++) {
    const candidate = mixColor(color, ink, step / 20);
    if (contrastRatio(candidate, background) >= ratio) return candidate;
  }
  return ink;
}

/**
 * Accent presets, one shade per theme: each meets WCAG AA as text on its page (through `--accent`),
 * and as a control against it (3:1). The first is the default accent.
 */
export const ACCENT_PRESETS = [
  { id: 'blue', light: '#486f9d', dark: '#b0cbed' },
  { id: 'teal', light: '#0f7676', dark: '#5cc8c8' },
  { id: 'green', light: '#2e7d32', dark: '#7fcf86' },
  { id: 'amber', light: '#8a6100', dark: '#f0c050' },
  { id: 'orange', light: '#b8420e', dark: '#f5a26a' },
  { id: 'red', light: '#c02626', dark: '#f28b82' },
  { id: 'rose', light: '#b8185a', dark: '#f48fb1' },
  { id: 'purple', light: '#6a4cc0', dark: '#b9a2f5' }
] as const satisfies ReadonlyArray<{ id: string; light: string; dark: string }>;

/** The palette a theme is drawn with: the chosen one, or black or white under high contrast. */
export function effectivePalette(settings: AppearanceSettings, theme: AppearanceTheme): AppearancePalette {
  const chosen = settings[theme];
  if (settings.highContrast !== true) return chosen;
  const page = theme === 'dark' ? '#000000' : '#ffffff';
  return { background: page, sidebar: page, accent: chosen.accent, contrast: 100 };
}

/** One palette feeds existing semantic CSS tokens, including independently colored sidebars. */
export function paletteTokens(background: string, accent: string, contrast: number, high = false): Record<string, string> {
  const ink = readableInk(background), c = contrast / 100;
  if (high) return highContrastTokens(background, accent);
  const card = mixColor(background, ink, .025 + .06 * c);
  const hover = mixColor(background, ink, .055 + .07 * c);
  return {
    '--page': background, '--ink': ink, '--card': card, '--sunk': mixColor(background, ink, .018 + .025 * c),
    '--hover': hover, '--raise': hover, '--popover': mixColor(background, ink, .06 + .06 * c),
    '--soft': readableTint(mixColor(background, ink, .53 + .2 * c), card, 4.5),
    '--faint': readableTint(mixColor(background, ink, .43 + .2 * c), card, 4.5),
    '--line': mixColor(background, ink, .09 + .13 * c), '--edge': mixColor(background, ink, .12 + .15 * c),
    '--track': mixColor(background, ink, .18 + .14 * c),
    '--blue': readableTint(accent, background, 4.5), '--accent': readableTint(accent, background, 4.5),
    '--accent-fill': accent, '--on-accent': readableInk(accent),
    '--wash': mixColor(background, accent, .12), '--blue-line': mixColor(background, accent, .3),
    '--accent-wash': mixColor(background, accent, .12), '--accent-edge': mixColor(background, accent, .35),
    '--knob-off': ink, '--knob-on': readableInk(accent),
    '--green': readableTint('#258552', card, 4.5), '--green-wash': mixColor(background, '#258552', .12),
    '--green-line': mixColor(background, '#258552', .3),
    '--red': readableTint('#d44545', card, 4.5), '--red-wash': mixColor(background, '#d44545', .12),
    '--red-line': mixColor(background, '#d44545', .3)
  };
}

/** High contrast: text and links at 7:1 (WCAG AAA), lines and control edges at 3:1 (WCAG 1.4.11). */
function highContrastTokens(background: string, accent: string): Record<string, string> {
  const ink = readableInk(background);
  const card = mixColor(background, ink, .06), hover = mixColor(background, ink, .14);
  // Measured on the hovered row, the surface nearest the ink: every other one is further from it.
  const text = (color: string) => readableTint(color, hover, 7);
  const edge = (amount: number) => readableTint(mixColor(background, ink, amount), hover, 3);
  const fill = readableTint(accent, background, 7);
  return {
    '--page': background, '--ink': ink, '--card': card, '--sunk': mixColor(background, ink, .04),
    '--hover': hover, '--raise': hover, '--popover': card,
    '--soft': text(mixColor(background, ink, .8)), '--faint': text(mixColor(background, ink, .72)),
    '--line': edge(.45), '--edge': edge(.6), '--track': edge(.5),
    '--blue': text(accent), '--accent': text(accent),
    '--accent-fill': fill, '--on-accent': readableInk(fill),
    '--wash': mixColor(background, accent, .2), '--blue-line': edge(.6),
    '--accent-wash': mixColor(background, accent, .2), '--accent-edge': readableTint(accent, hover, 3),
    '--knob-off': ink, '--knob-on': readableInk(fill),
    '--green': text('#258552'), '--green-wash': mixColor(background, '#258552', .2), '--green-line': readableTint('#258552', hover, 3),
    '--red': text('#d44545'), '--red-wash': mixColor(background, '#d44545', .2), '--red-line': readableTint('#d44545', hover, 3)
  };
}
