import { ACCENT_PRESETS, defaultAppearance, effectivePalette, mixColor, paletteTokens, type AppearanceSettings, type AppearanceTheme } from '../shared/appearance.js';
import type { UiPrefs } from '../shared/types.js';
import { $ } from './dom.js';
import { currentLanguage, onLanguageChange, t, ui } from './i18n.js';

const FONT_FAMILIES = {
  system: '', sans: 'Arial, Helvetica, sans-serif',
  serif: 'Georgia, "Times New Roman", serif', mono: '"Cascadia Mono", Consolas, monospace',
  legible: '"CoS Atkinson Hyperlegible Next", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
};
/** Preset names as the swatches say them: the project colors' names where the hue is the same. */
const PRESET_NAMES: Record<typeof ACCENT_PRESETS[number]['id'], () => string> = {
  blue: () => t('Blue'), teal: () => t('Teal'), green: () => t('Green'), amber: () => t('Amber'),
  orange: () => t('Orange'), red: () => t('Red'), rose: () => t('Rose'), purple: () => t('Purple')
};
/** Controls that only shape the chosen palette; high contrast draws its own page, so they wait. */
const PALETTE_ONLY = ['appearance-background', 'appearance-background-hex', 'appearance-sidebar', 'appearance-sidebar-hex', 'appearanceContrast', 'appearanceTranslucent'];
const appearanceListeners = new Set<() => void>();
/** Canvas/terminal renderers must refresh after the CSS palette has been applied. */
export function onAppearanceChanged(listener: () => void): () => void {
  appearanceListeners.add(listener);
  return () => { appearanceListeners.delete(listener); };
}
function tokens(element: HTMLElement, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) if (element.style.getPropertyValue(key) !== value) element.style.setProperty(key, value);
}

export function applyAppearance(theme: AppearanceTheme, settings?: AppearanceSettings): void {
  const value = settings ?? defaultAppearance(), palette = effectivePalette(value, theme), root = document.documentElement;
  const high = value.highContrast === true;
  root.dataset.theme = theme;
  root.dataset.highContrast = String(high);
  // A translucent sidebar mixes two colors; high contrast keeps every surface on its own page.
  root.dataset.translucentSidebar = String(value.translucentSidebar && !high);
  tokens(root, paletteTokens(palette.background, palette.accent, palette.contrast, high));
  root.style.setProperty('--text-scale', String(value.fontSize / 14));
  root.style.setProperty('--line-spacing', String(value.lineSpacing / 100));
  if (value.font === 'system') root.style.removeProperty('--ui-font');
  else root.style.setProperty('--ui-font', FONT_FAMILIES[value.font]);
  root.style.setProperty('--sidebar-color', palette.sidebar);
  // Glass is composed inside the window: a colored backdrop and translucent layer.
  // No native transparent window, desktop capture, or platform permission is needed.
  const sidebarBackground = value.translucentSidebar && !high ? mixColor(palette.sidebar, palette.background, .13) : palette.sidebar;
  for (const element of document.querySelectorAll<HTMLElement>('.sidebar, .app-topbar, .appearance-preview-sidebar, .connection-popover')) {
    tokens(element, paletteTokens(sidebarBackground, palette.accent, palette.contrast, high));
  }
  for (const listener of appearanceListeners) listener();
}

/** Only the in-progress form edit is local; the existing Settings queue owns persistence. */
export function initAppearance(save: (patch: { theme?: AppearanceTheme; appearance?: AppearanceSettings }) => void): { apply(ui: UiPrefs): void } {
  const panel = $('appearancePanel');
  let theme: AppearanceTheme = 'dark';
  let current = defaultAppearance();
  let editing = false;
  const colorKeys = ['accent', 'background', 'sidebar'] as const;
  const presets = $('appearanceAccentPresets');
  for (const preset of ACCENT_PRESETS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'appearance-swatch';
    swatch.dataset.preset = preset.id;
    swatch.setAttribute('role', 'radio');
    ui(swatch, 'aria-label', PRESET_NAMES[preset.id]);
    ui(swatch, 'title', PRESET_NAMES[preset.id]);
    swatch.addEventListener('click', () => {
      editing = false;
      current = { ...current, light: { ...current.light, accent: preset.light }, dark: { ...current.dark, accent: preset.dark } };
      paint(); save({ appearance: current });
    });
    presets.append(swatch);
  }
  // One stop in the tab order, arrows move between the eight, as in any radio group.
  presets.addEventListener('keydown', event => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    const swatches = [...presets.querySelectorAll<HTMLButtonElement>('.appearance-swatch')];
    const at = swatches.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const next = swatches[(at + step + swatches.length) % swatches.length]!;
    next.click();
    next.focus();
  });
  /** Shown and spoken alike: the slider's value is 140, a screen reader reads "1.4×". The decimal mark follows the app language, so it is a number format and not a catalog string. */
  function paintSpacing(): void {
    const spacing = `${new Intl.NumberFormat(currentLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(current.lineSpacing / 100)}×`;
    $('appearanceLineSpacingValue').textContent = spacing;
    $('appearanceLineSpacing').setAttribute('aria-valuetext', spacing);
  }
  function paint(): void {
    applyAppearance(theme, current);
    $<HTMLSelectElement>('appearanceTheme').value = theme;
    $<HTMLSelectElement>('appearanceFont').value = current.font;
    for (const option of panel.querySelectorAll<HTMLInputElement>('input[name="appearanceSidebarLayout"]')) option.checked = option.value === current.sidebarLayout;
    $<HTMLInputElement>('appearanceSize').value = String(current.fontSize);
    $('appearanceSizeValue').textContent = `${current.fontSize} px`;
    $<HTMLInputElement>('appearanceLineSpacing').value = String(current.lineSpacing);
    paintSpacing();
    $<HTMLInputElement>('appearanceContrast').value = String(current[theme].contrast);
    $('appearanceContrastValue').textContent = String(current[theme].contrast);
    $<HTMLInputElement>('appearanceTranslucent').checked = current.translucentSidebar;
    const high = current.highContrast === true;
    $<HTMLInputElement>('appearanceHighContrast').checked = high;
    for (const id of PALETTE_ONLY) $<HTMLInputElement>(id).disabled = high;
    for (const swatch of presets.querySelectorAll<HTMLButtonElement>('.appearance-swatch')) {
      const preset = ACCENT_PRESETS.find(entry => entry.id === swatch.dataset.preset)!;
      swatch.style.setProperty('--swatch', preset[theme]);
      // A preset is its pair: checked only while both themes' accents are exactly its two shades.
      const matches = (entry: typeof preset) => current.light.accent === entry.light && current.dark.accent === entry.dark;
      const checked = matches(preset);
      swatch.setAttribute('aria-checked', String(checked));
      swatch.tabIndex = checked || (!ACCENT_PRESETS.some(matches) && preset === ACCENT_PRESETS[0]) ? 0 : -1;
    }
    for (const key of colorKeys) {
      const color = current[theme][key];
      panel.querySelector<HTMLInputElement>(`[data-color="${key}"]`)!.value = color;
      const hex = panel.querySelector<HTMLInputElement>(`[data-hex="${key}"]`)!;
      if (document.activeElement !== hex) hex.value = color.toUpperCase();
    }
  }
  function update(control: HTMLInputElement | HTMLSelectElement): boolean {
    if (control.dataset.color || control.dataset.hex) {
      const key = (control.dataset.color ?? control.dataset.hex) as typeof colorKeys[number];
      const value = control.value.trim();
      if (!/^#[\da-fA-F]{6}$/.test(value)) {
        control.setAttribute('aria-invalid', 'true');
        return false;
      }
      control.removeAttribute('aria-invalid');
      current = { ...current, [theme]: { ...current[theme], [key]: value.toLowerCase() } };
      // Keep the hex text in sync with native picker gestures too.
      if (control.dataset.color) panel.querySelector<HTMLInputElement>(`[data-hex="${key}"]`)!.value = value.toUpperCase();
    } else if (control.id === 'appearanceSize') current = { ...current, fontSize: Number(control.value) };
    else if (control.id === 'appearanceLineSpacing') current = { ...current, lineSpacing: Number(control.value) };
    else if (control.id === 'appearanceContrast') current = { ...current, [theme]: { ...current[theme], contrast: Number(control.value) } };
    else if (control.id === 'appearanceFont') current = { ...current, font: control.value as AppearanceSettings['font'] };
    else if (control.name === 'appearanceSidebarLayout' && (control as HTMLInputElement).checked) current = { ...current, sidebarLayout: control.value as AppearanceSettings['sidebarLayout'] };
    else if (control.id === 'appearanceTranslucent') current = { ...current, translucentSidebar: (control as HTMLInputElement).checked };
    else if (control.id === 'appearanceHighContrast') current = { ...current, highContrast: (control as HTMLInputElement).checked };
    else return false;
    paint();
    return true;
  }
  panel.addEventListener('input', event => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement) || !control.id.startsWith('appearance')) return;
    editing = true;
    update(control);
  });
  panel.addEventListener('change', event => {
    const control = event.target;
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement) || !control.id.startsWith('appearance')) return;
    editing = false;
    if (control.id === 'appearanceTheme') {
      theme = control.value as AppearanceTheme;
      paint(); save({ theme });
    } else if (update(control)) save({ appearance: current });
    else {
      // Incomplete hex input never becomes CSS or durable config. Restore the last valid value.
      control.removeAttribute('aria-invalid');
      if (control.dataset.hex) control.value = current[theme][control.dataset.hex as typeof colorKeys[number]].toUpperCase();
    }
  });
  onLanguageChange(paintSpacing);
  $('appearanceReset').addEventListener('click', () => {
    // Colors and typography only: the sidebar keeps the layout the person chose.
    editing = false; current = { ...defaultAppearance(), sidebarLayout: current.sidebarLayout }; paint(); save({ appearance: current });
  });
  return { apply(ui) {
    if (editing) return;
    theme = ui.theme; current = ui.appearance ?? defaultAppearance(); paint();
  } };
}
