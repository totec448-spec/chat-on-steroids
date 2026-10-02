import { defaultAppearance, readableInk, mixColor, type AppearanceSettings } from '../shared/appearance.js';

/** User-facing 100% is 10% smaller than the former 1.3 base; IPC exposes relative zoom only. */
export const UI_BASE_ZOOM = 1.17;

/** Native Windows caption controls share the renderer's compact title-bar row. */
export function titleBarOverlayForTheme(theme: 'dark' | 'light', appearance = defaultAppearance()) {
  const palette = appearance[theme];
  const background = appearance.translucentSidebar ? mixColor(palette.sidebar, palette.background, .13) : palette.sidebar;
  return { height: 36, color: '#00000000', symbolColor: readableInk(background) };
}
export function windowBackgroundForTheme(theme: 'dark' | 'light', appearance?: AppearanceSettings): string {
  return (appearance ?? defaultAppearance())[theme].background;
}

export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MainWindowLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  useContentSize: false;
  resizable: true;
  maximizable: true;
}

const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function finiteWindowBounds(value: unknown): WindowBounds | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<Record<keyof WindowBounds, unknown>>;
  if (
    typeof row.x !== 'number' || !Number.isFinite(row.x) ||
    typeof row.y !== 'number' || !Number.isFinite(row.y) ||
    typeof row.width !== 'number' || !Number.isFinite(row.width) || row.width <= 0 ||
    typeof row.height !== 'number' || !Number.isFinite(row.height) || row.height <= 0
  ) return null;
  return {
    x: Math.round(row.x),
    y: Math.round(row.y),
    width: Math.max(1, Math.round(row.width)),
    height: Math.max(1, Math.round(row.height))
  };
}

interface WindowPlacement {
  bounds: WindowBounds;
  maximized: boolean;
}

/** Read the new placement envelope, while treating the legacy bare rectangle as normal state. */
function finiteWindowPlacement(value: unknown): WindowPlacement | null {
  const legacy = finiteWindowBounds(value);
  if (legacy) return { bounds: legacy, maximized: false };
  if (!value || typeof value !== 'object') return null;
  const row = value as { bounds?: unknown; maximized?: unknown };
  const bounds = finiteWindowBounds(row.bounds);
  if (!bounds || typeof row.maximized !== 'boolean') return null;
  return { bounds, maximized: row.maximized };
}

export function windowPlacementWasMaximized(value: unknown): boolean {
  return finiteWindowPlacement(value)?.maximized === true;
}

function intersectionArea(a: WindowBounds, b: DisplayWorkArea): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * BrowserWindow bounds and Electron screen work areas are both expressed in DIPs. Keep the
 * outer window inside that work area: using content-size bounds would add the Windows frame
 * on top and can put controls below the taskbar on scaled/small displays.
 */
export function windowLayoutForWorkArea(workArea: DisplayWorkArea): MainWindowLayout {
  const areaWidth = Math.max(1, Math.floor(workArea.width));
  const areaHeight = Math.max(1, Math.floor(workArea.height));
  const width = areaWidth;
  const height = areaHeight;

  return {
    x: Math.round(workArea.x),
    y: Math.round(workArea.y),
    width,
    height,
    minWidth: Math.min(MIN_WIDTH, width),
    minHeight: Math.min(MIN_HEIGHT, height),
    useContentSize: false,
    resizable: true,
    maximizable: true
  };
}

/**
 * Restores a normal window only when its last bounds still overlap an active display.
 * Disconnected-monitor coordinates fall back to the primary display, while a changed work area
 * keeps the restored window wholly reachable instead of preserving stale offscreen edges.
 */
export function windowLayoutForDisplays(
  primaryWorkArea: DisplayWorkArea,
  workAreas: readonly DisplayWorkArea[],
  savedBounds: unknown
): { layout: MainWindowLayout; restored: boolean } {
  const saved = finiteWindowPlacement(savedBounds)?.bounds ?? null;
  if (!saved) return { layout: windowLayoutForWorkArea(primaryWorkArea), restored: false };

  let matched: DisplayWorkArea | null = null;
  let matchedArea = 0;
  for (const workArea of workAreas) {
    const area = intersectionArea(saved, workArea);
    if (area > matchedArea) {
      matched = workArea;
      matchedArea = area;
    }
  }
  if (!matched || matchedArea <= 0) {
    return { layout: windowLayoutForWorkArea(primaryWorkArea), restored: false };
  }

  const areaWidth = Math.max(1, Math.floor(matched.width));
  const areaHeight = Math.max(1, Math.floor(matched.height));
  const areaX = Math.round(matched.x);
  const areaY = Math.round(matched.y);
  const minWidth = Math.min(MIN_WIDTH, areaWidth);
  const minHeight = Math.min(MIN_HEIGHT, areaHeight);
  const width = clamp(saved.width, minWidth, areaWidth);
  const height = clamp(saved.height, minHeight, areaHeight);
  const x = clamp(saved.x, areaX, areaX + areaWidth - width);
  const y = clamp(saved.y, areaY, areaY + areaHeight - height);

  return {
    restored: true,
    layout: {
      x,
      y,
      width,
      height,
      minWidth,
      minHeight,
      useContentSize: false,
      resizable: true,
      maximizable: true
    }
  };
}
