import type { AppearanceSettings } from './appearance.js';

export type ViewMenuCommand =
  | 'pet'
  | 'sidebar'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

export interface ViewMenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewMenuLabels {
  pet: string;
  sidebar: string;
  zoomIn: string;
  zoomOut: string;
  actualSize: string;
}

export interface ViewMenuSnapshot {
  petVisible: boolean;
  petReady: boolean;
  sidebarCollapsed: boolean;
  zoomPercent: number;
  theme: 'dark' | 'light';
  appearance?: AppearanceSettings;
  language: 'en' | 'es' | 'zh-CN' | 'zh-TW' | 'ja' | 'tr' | 'fr';
  labels: ViewMenuLabels;
}

export interface ViewMenuToggleRequest {
  anchor: ViewMenuAnchor;
  snapshot: ViewMenuSnapshot;
}

export interface ViewMenuToggleState {
  open: boolean;
}
