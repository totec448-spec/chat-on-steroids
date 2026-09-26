import './icons.css';
import { defaultAppearance, paletteTokens } from '../shared/appearance.js';
import type { ViewMenuApi } from '../preload/view-menu.js';
import type { ViewMenuCommand, ViewMenuSnapshot } from '../shared/view-menu.js';

declare global { interface Window { viewMenuApi: ViewMenuApi; } }

const api = window.viewMenuApi;
const FONT_FAMILIES = {
  system: '', sans: 'Arial, Helvetica, sans-serif',
  serif: 'Georgia, "Times New Roman", serif', mono: '"Cascadia Mono", Consolas, monospace'
} as const;

function button(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

function label(id: string, text: string): void {
  const span = button(id).querySelector('span');
  if (span) span.textContent = text;
}

function applyAppearance(snapshot: ViewMenuSnapshot): void {
  const value = snapshot.appearance ?? defaultAppearance();
  const palette = value[snapshot.theme];
  const root = document.documentElement;
  root.dataset.theme = snapshot.theme;
  root.lang = snapshot.language;
  for (const [key, color] of Object.entries(paletteTokens(palette.background, palette.accent, palette.contrast))) {
    root.style.setProperty(key, color);
  }
  root.style.setProperty('--text-scale', String(value.fontSize / 14));
  if (value.font === 'system') root.style.removeProperty('--ui-font');
  else root.style.setProperty('--ui-font', FONT_FAMILIES[value.font]);
}

function apply(snapshot: ViewMenuSnapshot): void {
  applyAppearance(snapshot);
  label('viewPet', snapshot.labels.pet);
  label('viewSidebar', snapshot.labels.sidebar);
  label('viewZoomIn', snapshot.labels.zoomIn);
  label('viewZoomOut', snapshot.labels.zoomOut);
  label('viewActualSize', snapshot.labels.actualSize);
  button('viewPet').setAttribute('aria-pressed', String(snapshot.petVisible));
  button('viewSidebar').setAttribute('aria-pressed', String(!snapshot.sidebarCollapsed));
  button('viewPet').disabled = snapshot.petVisible && !snapshot.petReady;
  document.getElementById('viewZoomValue')!.textContent = `${snapshot.zoomPercent}%`;
  const surface = document.querySelector<HTMLElement>('.view-menu-surface')!;
  surface.classList.remove('is-opening');
  void surface.offsetWidth;
  surface.classList.add('is-opening');
}

document.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-command]');
  if (!target || target.disabled) return;
  api.command(target.dataset.command as ViewMenuCommand);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); api.close(); }
});

api.onSnapshot(apply);
